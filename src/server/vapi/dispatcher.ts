import type { z } from "zod";
import { canonicalJSON, sha256Hex } from "@/server/lib/canonical-json";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
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
    say: `Ask the caller for: ${invalidFields.map((f) => f.field.replace(/_/g, " ")).join(", ")}.`,
    data: { invalid_fields: invalidFields },
  };
}

const INTERNAL_ERROR: ToolOutcome = {
  ok: false,
  errorCode: "internal_error",
  message: "The tool failed unexpectedly.",
  say: "Apologize for the trouble, take the caller's name and number, and tell them a team member will call back shortly.",
};

type CallInfo = { callId: string | null; callerPhone: string | null };

async function runTool(call: ParsedToolCall, ctx: CallInfo, deps: DispatchDeps) {
  const def = Object.hasOwn(deps.registry, call.name) ? deps.registry[call.name] : undefined;
  if (!def) {
    return {
      ok: false,
      errorCode: "unknown_tool",
      message: `Unknown tool: ${call.name || "(missing name)"}`,
      say: "Continue the conversation without this tool.",
    } satisfies ToolOutcome;
  }
  if (!call.args) {
    return {
      ok: false,
      errorCode: "invalid_arguments",
      message: call.argsError ?? "arguments could not be parsed",
      say: "Something went wrong reading that request. Try again.",
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

  try {
    const stored = ctx.callId ? await deps.repos.toolInvocations.findByKey(key) : null;
    if (stored && !(stored.ok === false && stored.result.error_code === "internal_error")) {
      logEvent("tool_invocation", {
        callId: ctx.callId,
        tool: call.name,
        ok: stored.ok,
        latency_ms: Math.round(performance.now() - started),
        errorCode: stored.ok ? null : (stored.result.error_code ?? null),
        replayed: true,
      });
      return payloadToResult(call.toolCallId, stored.result);
    }
  } catch (err) {
    // Idempotency lookup failing shouldn't block the caller; run the tool.
    logEvent("tool_idempotency_lookup_failed", { callId: ctx.callId, tool: call.name, error: err instanceof Error ? err.message : String(err) });
  }

  const outcome = await runTool(call, ctx, deps);
  let payload: Record<string, unknown> = outcomeToPayload(outcome);
  const latencyMs = Math.round(performance.now() - started);

  try {
    const saved = await deps.repos.toolInvocations.record({
      idempotencyKey: key,
      vapiCallId: ctx.callId,
      toolName: call.name,
      args: call.args,
      ok: outcome.ok,
      result: payload,
      latencyMs,
    });
    // A concurrent duplicate may have won the insert; answer consistently with it.
    payload = saved.result;
  } catch (err) {
    logEvent("tool_invocation_record_failed", { callId: ctx.callId, tool: call.name, error: err instanceof Error ? err.message : String(err) });
  }

  logEvent("tool_invocation", {
    callId: ctx.callId,
    tool: call.name,
    ok: payload.ok === true,
    latency_ms: latencyMs,
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
