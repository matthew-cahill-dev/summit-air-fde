// Tail padding for every call ending.
//
// Live evidence (Oct 21, 2026): Vapi's recording has the whole goodbye, but on the phone the last
// words were cut off. call-report shows the hang-up landing 0.15–0.67 s BEFORE the goodbye audio
// ends, and the carrier then drops whatever audio is still in flight when the line disconnects.
//
// Fix: the assistant requests "phone-call-control" in serverMessages, so Vapi delegates hang-up
// (and forwarding) to us instead of doing it itself (docs.vapi.ai/server-url/events, "Phone Call
// Control"). We answer at once, wait HANGUP_TAIL_MS, then end the call through the live control
// URL (POST {"type":"end-call"} to call.monitor.controlUrl). Every way a call can end (endCall
// after a goodbye, a safety stop, a commercial decline, a non-service or abusive caller, an
// end-call phrase) produces the same hang-up request, so all of them get the same padding.
import { logEvent } from "@/server/lib/log";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Silence after the final words before we disconnect: covers the early hang-up plus the carrier tail. */
export const DEFAULT_HANGUP_TAIL_MS = 1500;
const RETRY_DELAY_MS = 500;

export type CallControlDeps = {
  tailMs: number;
  /** POST a JSON control message to the call's control URL; throws on a non-2xx response. */
  post: (url: string, body: Obj) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export const defaultCallControlDeps = (tailMs = DEFAULT_HANGUP_TAIL_MS): CallControlDeps => ({
  tailMs,
  async post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`control URL answered HTTP ${res.status}`);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** The live control URL for this call, from the message's call object. Never logged (it controls the call). */
export function controlUrlOf(message: Obj): string | null {
  const call = isObj(message.call) ? message.call : null;
  const monitor = call && isObj(call.monitor) ? call.monitor : null;
  const url = monitor?.controlUrl;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

async function postWithRetry(deps: CallControlDeps, url: string, body: Obj, callId: string | null, what: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await deps.post(url, body);
      logEvent("call_control", { callId, action: what, ok: true, attempt });
      return true;
    } catch (err) {
      logEvent("call_control", { callId, action: what, ok: false, attempt, error: err instanceof Error ? err.message : String(err) });
      if (attempt === 1) await deps.sleep(RETRY_DELAY_MS);
    }
  }
  return false;
}

export type PhoneCallControlResult =
  | { handled: "hang-up"; done: Promise<boolean> }
  | { handled: "forward"; done: Promise<boolean> }
  | { handled: "ignored"; reason: string };

/**
 * Handle a phone-call-control message. Returns immediately (Vapi gets its 200 right away);
 * `done` settles when the delayed hang-up or the forward has been sent.
 */
export function handlePhoneCallControl(message: Obj, deps: CallControlDeps): PhoneCallControlResult {
  const call = isObj(message.call) ? message.call : {};
  const callId = typeof call.id === "string" ? call.id : null;
  const url = controlUrlOf(message);
  if (!url) {
    // Without the control URL we can't end or transfer the call; Vapi won't either. The caller
    // hanging up, or maxDurationSeconds, ends it. Logged loudly so it shows up in ops.
    logEvent("call_control", { callId, action: String(message.request), ok: false, error: "no monitor.controlUrl on the message" });
    return { handled: "ignored", reason: "no control URL" };
  }
  if (message.request === "hang-up") {
    const done = deps.sleep(deps.tailMs).then(() => postWithRetry(deps, url, { type: "end-call" }, callId, "hang-up"));
    return { handled: "hang-up", done };
  }
  if (message.request === "forward" && isObj(message.destination)) {
    // Delegated forwarding: transfers keep working when transfer_to_on_call is configured.
    const done = postWithRetry(deps, url, { type: "transfer", destination: message.destination }, callId, "forward");
    return { handled: "forward", done };
  }
  return { handled: "ignored", reason: `unknown request ${String(message.request)}` };
}
