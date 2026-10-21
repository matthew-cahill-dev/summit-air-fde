import type { z } from "zod";
import { canonicalJSON, sha256Hex } from "@/server/lib/canonical-json";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
import { RETRYABLE_ERROR_CODES } from "@/server/repositories/types";
import { parseToolCallsEnvelope, type ParsedToolCall } from "./envelope";
import type { ToolRegistry } from "./registry";
import type { ToolOutcome, ToolSettings } from "./types";

export type DispatchDeps = {
  registry: ToolRegistry;
  repos: Repositories;
  settings: ToolSettings;
  now?: () => Date;
};

/** One entry of Vapi's tool response. Exactly one of result/error. */
export type VapiToolResult = { toolCallId: string; result: string } | { toolCallId: string; error: string };
export type VapiToolResponse = { results: VapiToolResult[] };

type Payload = Record<string, unknown> & { ok: boolean };

export function idempotencyKey(callId: string, toolName: string, args: unknown): string {
  return `${callId}:${toolName}:${sha256Hex(canonicalJSON(args))}`;
}

/** The single-line JSON object that becomes `result` or `error`. */
export function outcomeToPayload(outcome: ToolOutcome): Payload {
  if (outcome.ok) {
    return { ok: true, ...outcome.data, ...(outcome.say ? { say: outcome.say } : {}) };
  }
  return {
    ok: false,
    error_code: outcome.errorCode,
    message: outcome.message,
    ...outcome.data,
    ...(outcome.say ? { say: outcome.say } : {}),
  };
}

export function payloadToResult(toolCallId: string, payload: Record<string, unknown>): VapiToolResult {
  const text = JSON.stringify(payload);
  return payload.ok === true ? { toolCallId, result: text } : { toolCallId, error: text };
}

/**
 * Fields where "ask the caller for X" is the wrong next step. Live (call 01a15ee6): the model left
 * out caller_confirmed after the caller had said yes, and "Ask the caller for: caller confirmed"
 * made Ava ask for the yes again and call book_appointment twice.
 */
const FIELD_NEXT_STEPS: Record<string, string> = {
  caller_confirmed:
    "If the caller already said yes to your recap, call book_appointment again right now with the same details and caller_confirmed true, without asking again. Only if they haven't said yes: recap and get a clear yes first.",
  slot_id: "Use a slot_id from the offered windows (triage_issue or get_availability); never make one up.",
  customer_id: "Use the customer_id from a verified lookup_customer result, or leave it out for a new caller.",
  address_id: "Use an address_id from a verified lookup_customer result, or pass the address instead.",
};

/** Turn Zod issues into an error that names each missing/invalid field. */
export function zodErrorOutcome(error: z.ZodError, rawArgs: Record<string, unknown>): ToolOutcome {
  const fields = new Map<string, string>();
  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.map(String).join(".") : "(arguments)";
    if (fields.has(field)) continue;
    const topKey = issue.path[0];
    const missing = typeof topKey === "string" && (rawArgs[topKey] === undefined || rawArgs[topKey] === null);
    fields.set(field, missing ? "required" : issue.message);
  }
  const invalidFields = [...fields].map(([field, problem]) => ({ field, problem }));
  const missing = invalidFields.filter((f) => f.problem === "required").map((f) => f.field);
  const invalid = invalidFields.filter((f) => f.problem !== "required");
  const parts = [
    missing.length ? `Missing: ${missing.join(", ")}` : null,
    invalid.length ? `Invalid: ${invalid.map((f) => `${f.field} (${f.problem})`).join(", ")}` : null,
  ].filter(Boolean);
  return {
    ok: false,
    errorCode: "invalid_arguments",
    message: parts.join(". "),
    say: [
      "Next:",
      ...invalidFields.filter((f) => FIELD_NEXT_STEPS[f.field]).map((f) => FIELD_NEXT_STEPS[f.field]),
      ...(invalidFields.some((f) => !FIELD_NEXT_STEPS[f.field])
        ? [`Ask the caller only for: ${invalidFields.filter((f) => !FIELD_NEXT_STEPS[f.field]).map((f) => f.field.replace(/_/g, " ")).join(", ")}, then call the tool again once.`]
        : []),
    ].join(" "),
    data: { invalid_fields: invalidFields },
  };
}

const INTERNAL_ERROR: ToolOutcome = {
  ok: false,
  errorCode: "internal_error",
  message: "The tool failed unexpectedly.",
  say: "Apologize once for the trouble. Next: call create_callback_request with reason backend_failure and a short summary; never guess what this tool would have said.",
};

type CallInfo = { callId: string | null; callerPhone: string | null };

/**
 * Wrap every repository method so its elapsed time is added to `clock.dbMs`. This splits
 * a slow tool call into database time vs everything else (e.g. a cold production DB).
 * Concurrent queries inside one handler are summed, so db_ms can exceed handler_ms.
 */
export function timedRepositories(repos: Repositories, clock: { dbMs: number }): Repositories {
  const wrap = <T extends object>(repo: T): T =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const started = performance.now();
          try {
            return await value.apply(target, args);
          } finally {
            clock.dbMs += performance.now() - started;
          }
        };
      },
    });
  return Object.fromEntries(Object.entries(repos).map(([k, r]) => [k, wrap(r)])) as Repositories;
}

async function runTool(call: ParsedToolCall, ctx: CallInfo, deps: DispatchDeps) {
  const def = Object.hasOwn(deps.registry, call.name) ? deps.registry[call.name] : undefined;
  if (!def) {
    return {
      ok: false,
      errorCode: "unknown_tool",
      message: `Unknown tool: ${call.name || "(missing name)"}`,
      say: "That tool isn't available. Next: continue without it; if you can't help without it, offer an office callback (create_callback_request).",
    } satisfies ToolOutcome;
  }
  if (!call.args) {
    return {
      ok: false,
      errorCode: "invalid_arguments",
      message: call.argsError ?? "arguments could not be parsed",
      say: "Something went wrong reading that request. Next: call the tool once more with valid arguments; if it fails again, treat it as a tool failure.",
    } satisfies ToolOutcome;
  }
  const parsed = def.schema.safeParse(call.args);
  if (!parsed.success) return zodErrorOutcome(parsed.error, call.args);
  try {
    return await def.handler(parsed.data, {
      ...ctx,
      repos: deps.repos,
      settings: deps.settings,
      now: deps.now?.() ?? new Date(),
    });
  } catch (err) {
    logEvent("tool_handler_error", {
      callId: ctx.callId,
      tool: call.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return INTERNAL_ERROR;
  }
}

async function invokeOne(
  call: ParsedToolCall,
  ctx: CallInfo,
  deps: DispatchDeps,
): Promise<VapiToolResult> {
  const started = performance.now();
  const argsForKey = call.args ?? { __unparseable: true };
  // Without a call ID (e.g. a dashboard tool test) there's nothing to dedupe on;
  // key on the toolCallId so the row is still recorded but never replayed.
  const key = ctx.callId
    ? idempotencyKey(ctx.callId, call.name, argsForKey)
    : `no-call:${call.toolCallId}:${call.name}:${sha256Hex(canonicalJSON(argsForKey))}`;

  const ms = (from: number) => Math.round(performance.now() - from);
  const idempotencyStarted = performance.now();
  let idempotencyMs = 0;
  try {
    const stored = ctx.callId ? await deps.repos.toolInvocations.findByKey(key) : null;
    idempotencyMs = ms(idempotencyStarted);
    const retryable = stored?.ok === false && (RETRYABLE_ERROR_CODES as readonly unknown[]).includes(stored.result.error_code);
    if (stored && !retryable) {
      logEvent("tool_invocation", {
        callId: ctx.callId,
        tool: call.name,
        ok: stored.ok,
        latency_ms: ms(started),
        idempotency_ms: idempotencyMs,
        errorCode: stored.ok ? null : (stored.result.error_code ?? null),
        replayed: true,
      });
      return payloadToResult(call.toolCallId, stored.result);
    }
  } catch (err) {
    idempotencyMs = ms(idempotencyStarted);
    // Idempotency lookup failing shouldn't block the caller; run the tool.
    logEvent("tool_idempotency_lookup_failed", { callId: ctx.callId, tool: call.name, error: err instanceof Error ? err.message : String(err) });
  }

  const clock = { dbMs: 0 };
  const handlerStarted = performance.now();
  const outcome = await runTool(call, ctx, { ...deps, repos: timedRepositories(deps.repos, clock) });
  const handlerMs = ms(handlerStarted);
  let payload: Record<string, unknown> = outcomeToPayload(outcome);
  // Stored latency: everything before the result is recorded (as before).
  const latencyMs = ms(started);

  const recordStarted = performance.now();
  try {
    const saved = await deps.repos.toolInvocations.record({
      idempotencyKey: key,
      vapiCallId: ctx.callId,
      toolName: call.name,
      args: call.args,
      ok: outcome.ok,
      result: payload,
      latencyMs,
      dbMs: Math.round(clock.dbMs),
    });
    // A concurrent duplicate may have won the insert; answer consistently with it.
    payload = saved.result;
  } catch (err) {
    logEvent("tool_invocation_record_failed", { callId: ctx.callId, tool: call.name, error: err instanceof Error ? err.message : String(err) });
  }

  const recordMs = ms(recordStarted);

  // total_ms = idempotency_ms + handler_ms + record_ms (+ tiny overhead);
  // db_ms is the handler's own repository time, so handler_ms - db_ms is app work.
  logEvent("tool_invocation", {
    callId: ctx.callId,
    tool: call.name,
    ok: payload.ok === true,
    latency_ms: latencyMs,
    total_ms: ms(started),
    idempotency_ms: idempotencyMs,
    handler_ms: handlerMs,
    db_ms: Math.round(clock.dbMs),
    record_ms: recordMs,
    errorCode: payload.ok === true ? null : (payload.error_code ?? null),
    replayed: false,
  });
  return payloadToResult(call.toolCallId, payload);
}

/** Handle a Vapi "tool-calls" message body. Always yields a result per toolCallId. */
export async function handleToolCalls(body: unknown, deps: DispatchDeps): Promise<VapiToolResponse> {
  const parsed = parseToolCallsEnvelope(body);
  if (!parsed) {
    logEvent("vapi_tools_unexpected_message", {});
    return { results: [] };
  }
  if (parsed.droppedWithoutId > 0) {
    logEvent("vapi_tools_dropped_calls", { callId: parsed.callId, count: parsed.droppedWithoutId });
  }
  const ctx = { callId: parsed.callId, callerPhone: parsed.callerPhone };
  const results = await Promise.all(parsed.toolCalls.map((call) => invokeOne(call, ctx, deps)));
  return { results };
}
