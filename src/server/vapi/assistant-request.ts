// Vapi assistant-request: answer with the saved assistant, plus a variableValue
// telling the prompt the caller ID matches an account. Callers aren't verified at
// this point, so NO stored name, address or membership is sent. Vapi allows 7.5 s end to end
// (https://docs.vapi.ai/server-url/events); we give ourselves 1.5 s and fall back
// to the plain assistantId on any failure, so a slow DB never drops a call.
import { isAuthorizedBearer } from "@/server/lib/auth";
import { logEvent } from "@/server/lib/log";
import { normalizePhoneE164 } from "@/server/lib/phone";
import type { CustomerRepository } from "@/server/repositories";
import { getCallerContext } from "@/server/services/caller-context";
import { getMessage } from "./envelope";

export type AssistantRequestDeps = {
  secret: string;
  enabled: boolean;
  assistantId: string | undefined;
  customers: () => CustomerRepository;
  demoCallerMap: ReadonlyMap<string, string>;
  deadlineMs?: number;
};

const DEFAULT_DEADLINE_MS = 1_500;

/** Pure: Liquid variables for the prompt. Deliberately nothing from the account itself. */
export function greetingVariables(): Record<string, string> {
  return { caller_recognized: "yes" };
}

class DeadlineExceeded extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded(`deadline ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function handleAssistantRequest(request: Request, deps: AssistantRequestDeps): Promise<Response> {
  if (!isAuthorizedBearer(request.headers.get("authorization"), deps.secret)) {
    logEvent("vapi_auth_rejected", { route: "assistant-request" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = performance.now();
  if (!deps.assistantId) {
    logEvent("assistant_request", { ok: false, reason: "VAPI_ASSISTANT_ID unset" });
    // Spoken to the caller by Vapi; the phone number's fallbackDestination (if any) takes over.
    return Response.json({ error: "Sorry, we can't take your call right now. Please try again in a few minutes." });
  }
  const plain = { assistantId: deps.assistantId };
  if (!deps.enabled) return Response.json(plain);

  let outcome = "plain";
  try {
    const body = await request.json().catch(() => undefined);
    const message = getMessage(body);
    const call = message?.call as { customer?: { number?: unknown } } | undefined;
    const raw = typeof call?.customer?.number === "string" ? call.customer.number : null;
    const phoneE164 = normalizePhoneE164(raw);
    if (message?.type !== "assistant-request" || !phoneE164) {
      outcome = !phoneE164 ? "no_caller_id" : "unexpected_message";
      return Response.json(plain);
    }
    const { context } = await withDeadline(
      getCallerContext(phoneE164, deps.customers(), deps.demoCallerMap),
      deps.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );
    if (!context.found) {
      outcome = "unknown_caller";
      return Response.json(plain);
    }
    outcome = "personalized";
    return Response.json({ ...plain, assistantOverrides: { variableValues: greetingVariables() } });
  } catch (err) {
    outcome = err instanceof DeadlineExceeded ? "deadline_exceeded" : "error";
    return Response.json(plain);
  } finally {
    logEvent("assistant_request", { ok: true, outcome, latency_ms: Math.round(performance.now() - started) });
  }
}
