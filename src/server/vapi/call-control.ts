// Every call ending: the goodbye plays in full, then a short fixed tail, then the line drops.
//
// Why we hang up ourselves: with Vapi's own hang-up the SIP BYE leaves ~0.1 s after the goodbye
// audio stops (pcap of call 01a15cfc) and the carrier clipped the last words on the phone. With
// "phone-call-control" in serverMessages, "the hangup and forwarding responsibilities are delegated
// to your server. Vapi will no longer do the actual transfer and hangup" (Vapi API spec,
// ServerMessagePhoneCallControl). We end the call through the live control URL
// (POST {"type":"end-call"} to call.monitor.controlUrl).
//
// Measured (Oct 21, 2026; Vapi call logs + SIP pcaps, see docs/TESTING.md L21-L22):
//   - Vapi sends the hang-up request ~5 ms after the goodbye stops (endCall's goodbye is blocking).
//   - Our end-call is only accepted once we have ANSWERED that request. While Vapi is still waiting
//     for our answer, every end-call fails. The previous version answered only after its end-call
//     succeeded: a deadlock. It answered 502, Vapi re-delivered twice (backoff 1 s, 2 s) and ended
//     the call itself 8.6-8.8 s after the goodbye; the line stayed open ~11 s and the idle hook
//     ("Take your time. I'm here.") fired into it.
//   - Answered first, then end-call 1.5 s later (morning version): BYE 3.57 s after the goodbye.
// So: answer at once, then send end-call a fixed, short HANGUP_SEND_DELAY_MS after the goodbye
// ends (Vapi's message.timestamp), with quick retries in case our answer hasn't landed yet.
// Expected BYE ≈ goodbye end + delay + ~1.6-1.8 s (end-call → BYE), i.e. ~2 s; the caller hears
// ~1.2-1.8 s of silence after the last word because their audio runs ~0.5-1 s behind ours.
// Hard guard: end-call is never first sent later than MAX_SEND_AFTER_GOODBYE_MS after the goodbye.
// The real teardown (SIP BYE) is read from Vapi's pcap by `npm run call-report`, which flags > 2.5 s.
import { logEvent } from "@/server/lib/log";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** How long after the goodbye ends (Vapi's send timestamp) the end-call is sent. */
export const DEFAULT_HANGUP_SEND_DELAY_MS = 400;
/** Hard guard on our side: the first end-call never goes out later than this after the goodbye. */
export const MAX_SEND_AFTER_GOODBYE_MS = 1000;
/** Retry delays for the end-call POST (4 attempts in all, the last ~1.75 s after the first). */
export const RETRY_DELAYS_MS = [250, 500, 1000] as const;
/** Ignore anchors that are implausible (clock skew, stale redelivery). */
const MAX_ANCHOR_SKEW_MS = 10_000;

export type CallControlDeps = {
  sendDelayMs: number;
  /** POST a JSON control message to the call's control URL; throws on a non-2xx response. */
  post: (url: string, body: Obj) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Runs work after our answer has been sent (Next's `after` in production). */
  defer: (task: () => Promise<unknown>) => void;
  now?: () => number;
};

export const defaultCallControlDeps = (
  sendDelayMs = DEFAULT_HANGUP_SEND_DELAY_MS,
  defer: CallControlDeps["defer"] = (task) => void task(),
): CallControlDeps => ({
  sendDelayMs,
  async post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`control URL answered HTTP ${res.status}`);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defer,
});

/** The live control URL for this call, from the message's call object. Never logged (it controls the call). */
export function controlUrlOf(message: Obj): string | null {
  const call = isObj(message.call) ? message.call : null;
  const monitor = call && isObj(call.monitor) ? call.monitor : null;
  const url = monitor?.controlUrl;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/** When the goodbye ended: Vapi's send timestamp (it sends right after the blocking goodbye). Null if implausible. */
export function goodbyeEndAt(message: Obj, now: number): number | null {
  const sent = typeof message.timestamp === "number" ? message.timestamp : null;
  return sent !== null && Math.abs(sent - now) <= MAX_ANCHOR_SKEW_MS ? sent : null;
}

/** Wait before the first end-call: goodbye end + delay, never past the hard guard, never negative. */
export function hangupDelayMs(message: Obj, sendDelayMs: number, now: number): number {
  const end = goodbyeEndAt(message, now) ?? now;
  const delay = Math.min(sendDelayMs, MAX_SEND_AFTER_GOODBYE_MS);
  return Math.max(0, Math.round(end + delay - now));
}

async function postWithRetry(deps: CallControlDeps, url: string, body: Obj, callId: string | null, what: string, since: number | null) {
  const now = deps.now ?? Date.now;
  const attempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sentAfterGoodbye = since === null ? null : now() - since;
    try {
      await deps.post(url, body);
      logEvent("call_control", { callId, action: what, ok: true, attempt, sent_after_goodbye_ms: sentAfterGoodbye, accepted_after_goodbye_ms: since === null ? null : now() - since });
      return true;
    } catch (err) {
      logEvent("call_control", { callId, action: what, ok: false, attempt, sent_after_goodbye_ms: sentAfterGoodbye, error: err instanceof Error ? err.message : String(err) });
      if (attempt < attempts) await deps.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  return false;
}

export type PhoneCallControlResult =
  | { handled: "hang-up"; delayMs: number; done: Promise<boolean> }
  | { handled: "forward"; done: Promise<boolean> }
  | { handled: "ignored"; reason: string };

/**
 * Handle a phone-call-control message. The caller answers Vapi right away; the end-call or
 * transfer runs through deps.defer, after the answer. `done` settles true once Vapi accepted it.
 */
export function handlePhoneCallControl(message: Obj, deps: CallControlDeps): PhoneCallControlResult {
  const call = isObj(message.call) ? message.call : {};
  const callId = typeof call.id === "string" ? call.id : null;
  const url = controlUrlOf(message);
  if (!url) {
    logEvent("call_control", { callId, action: String(message.request), ok: false, error: "no monitor.controlUrl on the message" });
    return { handled: "ignored", reason: "no control URL" };
  }
  const run = (task: () => Promise<boolean>): Promise<boolean> =>
    new Promise((resolve) => deps.defer(() => task().then(resolve, () => resolve(false))));

  if (message.request === "hang-up") {
    const now = (deps.now ?? Date.now)();
    const anchor = goodbyeEndAt(message, now);
    const delayMs = hangupDelayMs(message, deps.sendDelayMs, now);
    logEvent("call_control_scheduled", {
      callId,
      action: "hang-up",
      delay_ms: delayMs,
      received_after_goodbye_ms: anchor === null ? null : now - anchor,
      anchored: anchor !== null,
    });
    const done = run(async () => {
      if (delayMs > 0) await deps.sleep(delayMs);
      return postWithRetry(deps, url, { type: "end-call" }, callId, "hang-up", anchor);
    });
    return { handled: "hang-up", delayMs, done };
  }
  if (message.request === "forward" && isObj(message.destination)) {
    // Delegated forwarding: transfers keep working when transfer_to_on_call is configured.
    const done = run(() => postWithRetry(deps, url, { type: "transfer", destination: message.destination }, callId, "forward", null));
    return { handled: "forward", done };
  }
  return { handled: "ignored", reason: `unknown request ${String(message.request)}` };
}
