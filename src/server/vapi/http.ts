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
  return Response.json(response);
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
    // Hang-up and forwarding are delegated to us: answer now, act after the tail (see call-control.ts).
    const outcome = handlePhoneCallControl(message, deps.callControl ?? defaultCallControlDeps());
    if (outcome.handled !== "ignored") void outcome.done;
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
  return Response.json({ ok: true });
}
