// Request handlers for the Vapi webhooks, separated from the Next.js route
// files so tests can inject repositories and secrets.
import { isAuthorizedBearer } from "@/server/lib/auth";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
import { handleToolCalls } from "./dispatcher";
import { describeEnvelopeShape } from "./envelope";
import { parseEndOfCallReport } from "./events";
import type { ToolRegistry } from "./registry";

export type VapiHttpDeps = {
  secret: string;
  repos: () => Repositories;
  registry: ToolRegistry;
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
  const response = await handleToolCalls(body, { registry: deps.registry, repos: deps.repos() });
  return Response.json(response);
}

export async function handleEventsRequest(request: Request, deps: Omit<VapiHttpDeps, "registry">): Promise<Response> {
  if (!isAuthorizedBearer(request.headers.get("authorization"), deps.secret)) {
    logEvent("vapi_auth_rejected", { route: "events" });
    return unauthorized();
  }
  const body = await readJson(request);
  const shape = describeEnvelopeShape(body);
  logEvent("vapi_envelope", { route: "events", ...shape });

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
