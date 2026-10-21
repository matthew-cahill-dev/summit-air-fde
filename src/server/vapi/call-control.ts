// Every call ending: the goodbye plays in full, then ~1.5 s of silence, then the line drops.
//
// Why we hang up ourselves: Vapi's recording had the whole goodbye, but carriers clipped the last
// words on the phone when Vapi disconnected right after them. With "phone-call-control" in
// serverMessages, Vapi delegates hang-up (and forwarding) to us (docs.vapi.ai/server-url/events);
// we end the call through the live control URL (POST {"type":"end-call"} to call.monitor.controlUrl).
//
// Timing, measured from Vapi's call log on call 01a15e9b (Oct 21, 2026):
//   goodbye stops speaking → Vapi sends phone-call-control (≈ same instant; endCall's goodbye is blocking)
//   → our server receives it (~0.3-0.5 s later) → our end-call POST → Vapi tears the call down ~1.1-1.3 s
//   after that POST. With a fixed 1.5 s wait after RECEIPT the caller heard ~3.1 s of silence.
// So the wait is anchored to the end of the goodbye (Vapi's timestamp, or the goodbye's own endTime
// when the live artifact shows it ending later) and accounts for the teardown time, so the line
// drops about TARGET after the last word. The farewell itself is never delayed: Vapi speaks it
// before it asks us to hang up, and we only ever delay the hang-up, never the speech.
//
// Failsafe layers (see docs/ARCHITECTURE.md ADR-10): we answer Vapi only after the end-call POST
// succeeded (3 attempts); if all fail we answer 502 and Vapi re-delivers the request
// (assistant.server.backoffPlan); maxDurationSeconds caps any call that still stays open.
import { logEvent } from "@/server/lib/log";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Target silence after the last word of the goodbye before the line drops. */
export const DEFAULT_HANGUP_TAIL_MS = 1500;
/** Measured: our end-call POST → Vapi actually tears the call down (Oct 21 call log: ~1.1-1.3 s). */
export const EXPECTED_TEARDOWN_MS = 1200;
/** Retry delays for the end-call POST (3 attempts in all). */
export const RETRY_DELAYS_MS = [300, 800] as const;
/** Ignore anchors that are implausible (clock skew, stale redelivery). */
const MAX_ANCHOR_SKEW_MS = 10_000;
/** Speaking rate used only when a goodbye has started but has no endTime yet (measured ~240 ms/word). */
const MS_PER_WORD = 300;

export type CallControlDeps = {
  tailMs: number;
  teardownMs?: number;
  /** POST a JSON control message to the call's control URL; throws on a non-2xx response. */
  post: (url: string, body: Obj) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export const defaultCallControlDeps = (tailMs = DEFAULT_HANGUP_TAIL_MS): CallControlDeps => ({
  tailMs,
  teardownMs: EXPECTED_TEARDOWN_MS,
  async post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    });
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

/**
 * When the goodbye ends (epoch ms): the later of Vapi's send timestamp and the last assistant
 * message's end in the live artifact (its endTime, or start + an estimate while it's still playing).
 * Null when neither is usable.
 */
export function farewellEndAt(message: Obj, now: number): number | null {
  const sent = typeof message.timestamp === "number" ? message.timestamp : null;
  const artifact = isObj(message.artifact) ? message.artifact : null;
  const messages = Array.isArray(artifact?.messages) ? (artifact!.messages as Obj[]) : [];
  const lastBot = [...messages].reverse().find((m) => m.role === "bot" || m.role === "assistant");
  let spokenEnd: number | null = null;
  if (lastBot && typeof lastBot.time === "number") {
    if (typeof lastBot.endTime === "number") spokenEnd = lastBot.endTime;
    else if (typeof lastBot.message === "string") spokenEnd = lastBot.time + lastBot.message.split(/\s+/).filter(Boolean).length * MS_PER_WORD;
  }
  const candidates = [sent, spokenEnd].filter((t): t is number => t !== null && Math.abs(t - now) <= MAX_ANCHOR_SKEW_MS);
  return candidates.length ? Math.max(...candidates) : null;
}

/** How long to wait before sending end-call so the line drops ~tailMs after the last word. */
export function hangupDelayMs(message: Obj, deps: Pick<CallControlDeps, "tailMs" | "teardownMs">, now: number): number {
  const end = farewellEndAt(message, now);
  const teardown = deps.teardownMs ?? EXPECTED_TEARDOWN_MS;
  // No usable anchor: assume the goodbye just ended (Vapi sends after it with a blocking goodbye).
  const target = (end ?? now) + deps.tailMs - teardown;
  return Math.max(0, Math.min(Math.round(target - now), deps.tailMs + MAX_ANCHOR_SKEW_MS));
}

async function postWithRetry(deps: CallControlDeps, url: string, body: Obj, callId: string | null, what: string) {
  const attempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deps.post(url, body);
      logEvent("call_control", { callId, action: what, ok: true, attempt });
      return true;
    } catch (err) {
      logEvent("call_control", { callId, action: what, ok: false, attempt, error: err instanceof Error ? err.message : String(err) });
      if (attempt < attempts) await deps.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  return false;
}

export type PhoneCallControlResult =
  | { handled: "hang-up"; delayMs: number; done: Promise<boolean> }
  | { handled: "forward"; done: Promise<boolean> }
  | { handled: "ignored"; reason: string };

/** Handle a phone-call-control message. `done` settles true once Vapi accepted our end-call / transfer. */
export function handlePhoneCallControl(message: Obj, deps: CallControlDeps): PhoneCallControlResult {
  const call = isObj(message.call) ? message.call : {};
  const callId = typeof call.id === "string" ? call.id : null;
  const url = controlUrlOf(message);
  if (!url) {
    logEvent("call_control", { callId, action: String(message.request), ok: false, error: "no monitor.controlUrl on the message" });
    return { handled: "ignored", reason: "no control URL" };
  }
  if (message.request === "hang-up") {
    const now = (deps.now ?? Date.now)();
    const delayMs = hangupDelayMs(message, deps, now);
    logEvent("call_control_scheduled", { callId, action: "hang-up", delay_ms: delayMs, anchored: farewellEndAt(message, now) !== null });
    const done = (delayMs > 0 ? deps.sleep(delayMs) : Promise.resolve()).then(() =>
      postWithRetry(deps, url, { type: "end-call" }, callId, "hang-up"),
    );
    return { handled: "hang-up", delayMs, done };
  }
  if (message.request === "forward" && isObj(message.destination)) {
    // Delegated forwarding: transfers keep working when transfer_to_on_call is configured.
    const done = postWithRetry(deps, url, { type: "transfer", destination: message.destination }, callId, "forward");
    return { handled: "forward", done };
  }
  return { handled: "ignored", reason: `unknown request ${String(message.request)}` };
}
