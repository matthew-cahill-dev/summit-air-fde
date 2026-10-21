// Request handlers for the Vapi webhooks, separated from the Next.js route
// files so tests can inject repositories and secrets.
import { isAuthorizedBearer } from "@/server/lib/auth";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
import { defaultCallControlDeps, handlePhoneCallControl, type CallControlDeps } from "./call-control";
import { handleToolCalls } from "./dispatcher";
import { describeEnvelopeShape, getMessage } from "./envelope";
import { parseEndOfCallReport } from "./events";
import type { ToolRegistry } from "./registry";
import type { ToolSettings } from "./types";

export type VapiHttpDeps = {
  secret: string;
  repos: () => Repositories;
  registry: ToolRegistry;
  settings: ToolSettings;
  now?: () => Date;
  /** Delayed hang-up / forwarding for phone-call-control (tail padding). */
  callControl?: CallControlDeps;
};

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleToolsRequest(request: Request, deps: VapiHttpDeps): Promise<Response> {
  // Request timing, to split Vapi's measured webhook time (call-report) into inbound delay,
  // our total request time and the return trip. Vapi stamps message.timestamp when it sends.
  const receivedAt = Date.now();
  const startedAt = performance.now();
  if (!isAuthorizedBearer(request.headers.get("authorization"), deps.secret)) {
    logEvent("vapi_auth_rejected", { route: "tools" });
    return unauthorized();
  }
  const body = await readJson(request);
  logEvent("vapi_envelope", { route: "tools", ...describeEnvelopeShape(body) });
  // Always 200: Vapi ignores non-200 bodies and the agent hears "no result".
  const response = await handleToolCalls(body, {
    registry: deps.registry,
    repos: deps.repos(),
    settings: deps.settings,
    now: deps.now,
  });
  logEvent("tools_request", requestTiming(body, receivedAt, startedAt));
  return Response.json(response);
}

/**
 * received_at: when our handler got the request; vapi_sent_at: Vapi's message.timestamp;
 * inbound_ms: the difference (network + TLS + Replit edge; clocks are NTP-synced, so ±tens of ms);
 * request_ms: our whole handling time, auth to response.
 */
export function requestTiming(body: unknown, receivedAt: number, startedAt: number) {
  const message = getMessage(body);
  const sentAt = typeof message?.timestamp === "number" ? message.timestamp : null;
  const call = message && typeof message.call === "object" && message.call !== null ? (message.call as Record<string, unknown>) : null;
  return {
    callId: typeof call?.id === "string" ? call.id : null,
    received_at: new Date(receivedAt).toISOString(),
    vapi_sent_at: sentAt === null ? null : new Date(sentAt).toISOString(),
    inbound_ms: sentAt === null ? null : receivedAt - sentAt,
    request_ms: Math.round(performance.now() - startedAt),
  };
}

let warming: Promise<void> | null = null;

/**
 * Fire-and-forget `select 1`. Returns false if a ping is already in flight (several
 * calls starting together need only one). Failures are logged, never thrown.
 */
export function warmDatabase(ping: () => Promise<void>): boolean {
  if (warming) return false;
  const started = performance.now();
  warming = Promise.resolve()
    .then(ping)
    .then(
      () => logEvent("db_keep_warm", { ok: true, db_ms: Math.round(performance.now() - started) }),
      (err) => logEvent("db_keep_warm", { ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    .finally(() => {
      warming = null;
    });
  return true;
}

export async function handleEventsRequest(
  request: Request,
  deps: Pick<VapiHttpDeps, "secret" | "repos" | "callControl">,
): Promise<Response> {
  if (!isAuthorizedBearer(request.headers.get("authorization"), deps.secret)) {
    logEvent("vapi_auth_rejected", { route: "events" });
    return unauthorized();
  }
  const body = await readJson(request);
  const shape = describeEnvelopeShape(body);
  logEvent("vapi_envelope", { route: "events", ...shape });

  const message = getMessage(body);
  if (message?.type === "phone-call-control") {
    // Hang-up and forwarding are delegated to us (see call-control.ts). We answer only once Vapi
    // accepted the end-call/transfer: if it failed (or this process dies mid-wait), Vapi gets a 5xx
    // or a timeout and re-delivers the request (assistant.server.backoffPlan), so a call can't be
    // left open by one lost request. The goodbye has already played; this only times the hang-up.
    const outcome = handlePhoneCallControl(message, deps.callControl ?? defaultCallControlDeps());
    if (outcome.handled === "ignored") {
      // Without a control URL nobody can end the call: report failure so Vapi retries rather than assume it's done.
      const failed = outcome.reason === "no control URL";
      return Response.json({ ok: !failed, handled: "ignored", reason: outcome.reason }, { status: failed ? 502 : 200 });
    }
    const ok = await outcome.done;
    return Response.json({ ok, handled: outcome.handled }, { status: ok ? 200 : 502 });
  }
  if (message?.type === "status-update") {
    // Keep-warm: the call just connected, so wake the database during the greeting
    // instead of on the first tool call. Never awaited; Vapi gets its 200 right away.
    if (message.status === "in-progress") {
      const started = warmDatabase(() => deps.repos().health.ping());
      return Response.json({ ok: true, warming: started });
    }
    return Response.json({ ok: true, ignored: "status-update" });
  }

  const report = parseEndOfCallReport(body);
  if (!report) return Response.json({ ok: true, ignored: shape.messageType ?? "unknown" });

  try {
    await deps.repos().calls.upsertEndOfCallReport(report);
    logEvent("call_report_saved", { callId: report.vapiCallId, endedReason: report.endedReason });
  } catch (err) {
    logEvent("call_report_save_failed", {
      callId: report.vapiCallId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return Response.json({ ok: true });
}
