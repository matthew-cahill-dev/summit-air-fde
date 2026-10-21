// Request handlers for the Vapi webhooks, separated from the Next.js route
// files so tests can inject repositories and secrets.
import { isAuthorizedBearer } from "@/server/lib/auth";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
import { defaultCallControlDeps, handlePhoneCallControl, type CallControlDeps } from "./call-control";
import { handleToolCalls } from "./dispatcher";
import { describeEnvelopeShape, getMessage } from "./envelope";
import { reconcileSafety, safetyNetAtHangUp } from "@/server/services/safety-reconcile";
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
    // Hang-up and forwarding are delegated to us (see call-control.ts). Answer at once: Vapi only
    // accepts our end-call after this request is answered, so holding the answer until the
    // end-call succeeds deadlocks (measured: 502, re-deliveries, line open ~11 s). The end-call
    // runs after the answer (deps.callControl.defer), with its own retries.
    // Before the line drops: an emergency or safety call with no record gets one now, even when no
    // tool ran (eval 7021919d) or every tool failed (live call 01a15feb). Never rejects, never
    // holds the answer, and delays the end-call by at most SAFETY_CHECK_BUDGET_MS.
    const safetyCheck =
      message.request === "hang-up"
        ? Promise.resolve()
            .then(() => safetyNetAtHangUp(message, deps.repos()))
            .catch((err) => {
            logEvent("hangup_safety_net_failed", { error: err instanceof Error ? err.message : String(err) });
            return null;
          })
        : undefined;
    const outcome = handlePhoneCallControl(message, deps.callControl ?? defaultCallControlDeps(), safetyCheck);
    if (outcome.handled === "ignored") {
      return Response.json({ ok: false, handled: "ignored", reason: outcome.reason });
    }
    return Response.json({ ok: true, handled: outcome.handled });
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
  // Last line of defense: safety or medical signs in the caller's words with no record on the call.
  try {
    await reconcileSafety(report, deps.repos());
  } catch (err) {
    logEvent("safety_reconcile_failed", { callId: report.vapiCallId, error: err instanceof Error ? err.message : String(err) });
  }
  return Response.json({ ok: true });
}
