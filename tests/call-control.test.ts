// Goodbye tail padding: Vapi delegates every hang-up to us (phone-call-control); we wait, then
// end the call through monitor.controlUrl. See src/server/vapi/call-control.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANGUP_TAIL_MS,
  EXPECTED_TEARDOWN_MS,
  farewellEndAt,
  handlePhoneCallControl,
  hangupDelayMs,
  RETRY_DELAYS_MS,
  type CallControlDeps,
} from "@/server/vapi/call-control";
import { handleEventsRequest } from "@/server/vapi/http";
import { buildDesiredAssistant, renderSystemPrompt, type JsonObject } from "@/vapi-sync/render";
import { composeAssistant, MAIN_TARGET, parseTarget } from "@/vapi-sync/variants";
import { post, TEST_SECRET, testRepos } from "./helpers";

const CONTROL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-123/control";

function fakeControl(opts: { failFirst?: number; now?: number } = {}) {
  const events: string[] = [];
  let failures = opts.failFirst ?? 0;
  const deps: CallControlDeps = {
    tailMs: DEFAULT_HANGUP_TAIL_MS,
    teardownMs: EXPECTED_TEARDOWN_MS,
    now: () => opts.now ?? NOW,
    async post(url, body) {
      if (failures > 0) {
        failures--;
        events.push(`post-failed ${String(body.type)}`);
        throw new Error("HTTP 502");
      }
      events.push(`post ${url === CONTROL ? "controlUrl" : url} ${JSON.stringify(body)}`);
    },
    async sleep(ms) {
      events.push(`sleep ${ms}`);
    },
  };
  return { deps, events };
}

const NOW = 1_792_589_000_000;
const hangUp = (over: JsonObject = {}) => ({ type: "phone-call-control", request: "hang-up", call: { id: "call-123", monitor: { controlUrl: CONTROL } }, ...over });

describe("ending order: goodbye in full → ~1.5 s of silence → hang-up", () => {
  // Measured on call 01a15e9b: Vapi sends the hang-up request as the (blocking) goodbye stops; it
  // reached us ~0.3-0.6 s later; Vapi tore the call down ~1.2 s after our end-call. A fixed 1.5 s
  // wait after receipt gave ~3.1 s of silence. Now the wait is anchored to the end of the goodbye.

  it("anchors on Vapi's send time: a request that arrives 0.5 s late gets end-call right away", () => {
    const sentAtGoodbyeEnd = NOW - 500;
    const delay = hangupDelayMs(hangUp({ timestamp: sentAtGoodbyeEnd }), { tailMs: 1500, teardownMs: 1200 }, NOW);
    expect(delay).toBe(0); // 1500 - 1200 - 500 < 0 → hang up now; teardown lands ~1.7 s after the last word
  });

  it("never cuts a goodbye that's still playing: anchors on its endTime from the live artifact", () => {
    const artifact = { messages: [{ role: "user", time: NOW - 4000 }, { role: "bot", time: NOW - 300, endTime: NOW + 2400, message: "Thanks for calling…" }] };
    const delay = hangupDelayMs(hangUp({ timestamp: NOW - 50, artifact }), { tailMs: 1500, teardownMs: 1200 }, NOW);
    expect(delay).toBe(2400 + 1500 - 1200); // goodbye ends in 2.4 s; line drops ~1.5 s after that
  });

  it("estimates a still-playing goodbye with no endTime from its words", () => {
    const artifact = { messages: [{ role: "bot", time: NOW, message: "Thanks for calling Summit Air. Take care, and goodbye for now." }] };
    expect(farewellEndAt(hangUp({ artifact }), NOW)).toBe(NOW + 11 * 300);
  });

  it("ignores implausible anchors (clock skew, stale redelivery) and falls back to now + tail - teardown", () => {
    expect(hangupDelayMs(hangUp({ timestamp: NOW - 60_000 }), { tailMs: 1500, teardownMs: 1200 }, NOW)).toBe(300);
    expect(hangupDelayMs(hangUp(), { tailMs: 1500, teardownMs: 1200 }, NOW)).toBe(300);
  });

  it("the handler sends end-call after the computed delay and only then reports done", async () => {
    const { deps, events } = fakeControl();
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW }), deps);
    expect(out).toMatchObject({ handled: "hang-up", delayMs: 300 });
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["sleep 300", 'post controlUrl {"type":"end-call"}']);
  });
});

describe("hang-up failsafe", () => {
  it("retries the end-call (3 attempts, 300 ms then 800 ms apart)", async () => {
    const { deps, events } = fakeControl({ failFirst: 2 });
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW - 1000 }), deps);
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["post-failed end-call", "sleep 300", "post-failed end-call", "sleep 800", 'post controlUrl {"type":"end-call"}']);
    expect(RETRY_DELAYS_MS).toEqual([300, 800]);
  });

  it("reports failure when every attempt fails (the events endpoint then answers 502 so Vapi re-delivers)", async () => {
    const { deps } = fakeControl({ failFirst: 3 });
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW - 1000 }), deps);
    expect(out.handled !== "ignored" && (await out.done)).toBe(false);
  });

  it("forward: transfers right away (delegated forwarding keeps transfers working)", async () => {
    const { deps, events } = fakeControl();
    const destination = { type: "number", number: "+17185550100" };
    const out = handlePhoneCallControl(hangUp({ request: "forward", destination }), deps);
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual([`post controlUrl ${JSON.stringify({ type: "transfer", destination })}`]);
  });

  it("without a control URL (or a non-https one) nothing is sent", () => {
    const { deps, events } = fakeControl();
    expect(handlePhoneCallControl({ type: "phone-call-control", request: "hang-up", call: { id: "x" } }, deps)).toMatchObject({ handled: "ignored" });
    expect(handlePhoneCallControl(hangUp({ call: { monitor: { controlUrl: "http://insecure" } } }), deps)).toMatchObject({ handled: "ignored" });
    expect(events).toEqual([]);
  });
});

describe("events endpoint", () => {
  const send = (message: JsonObject, callControl: CallControlDeps) =>
    handleEventsRequest(post("/api/vapi/events", { message }, `Bearer ${TEST_SECRET}`), { secret: TEST_SECRET, repos: testRepos, callControl });

  it("answers phone-call-control only after the end-call went through (so a crash means Vapi retries)", async () => {
    const { deps, events } = fakeControl();
    const res = await send(hangUp({ timestamp: NOW - 400 }), deps);
    expect(events).toEqual(['post controlUrl {"type":"end-call"}']); // already sent before we answered
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: "hang-up" });
  });

  it("answers 502 when the end-call failed every attempt, or there's no control URL", async () => {
    expect((await send(hangUp({ timestamp: NOW }), fakeControl({ failFirst: 3 }).deps)).status).toBe(502);
    expect((await send({ type: "phone-call-control", request: "hang-up", call: { id: "x" } }, fakeControl().deps)).status).toBe(502);
  });

  it("requires the bearer secret like every other event", async () => {
    const { deps, events } = fakeControl();
    const res = await handleEventsRequest(post("/api/vapi/events", { message: hangUp() }, null), { secret: TEST_SECRET, repos: testRepos, callControl: deps });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });
});

describe("every ending path uses the same padded hang-up", () => {
  const VAPI = join(process.cwd(), "vapi");
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as JsonObject;
  const base = read(join(VAPI, "assistant.json"));
  const prompt = renderSystemPrompt(readFileSync(join(VAPI, "system-prompt.md"), "utf8"), { transferAvailable: false, timeZone: "America/New_York" });
  const names = (dir: string) => readdirSync(join(VAPI, dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

  it("the prompt ends every path (goodbye, safety, commercial, non-service, abuse) the same way: endCall", () => {
    const section = prompt.slice(prompt.indexOf("# Ending the call"), prompt.indexOf("# Business facts"));
    expect(section).toContain("call endCall immediately");
    for (const path of [
      "Wait for them to acknowledge, then end the call (see Ending the call)", // safety stop
      "Then thank them and end the call.", // commercial decline
      "one polite sentence", // non-service
      "don't repeat it or argue; end the call", // abusive
    ]) {
      expect(prompt, path).toContain(path);
    }
    // No other way to end a call is ever described.
    expect(prompt).not.toMatch(/hang up yourself|transfer_to_on_call to end|say goodbye and stop/i);
  });

  it("every model variant, voice and target delegates hang-up to the padded handler", () => {
    const targets = [MAIN_TARGET.overlay, ...names("targets").map((t) => parseTarget(t, read(join(VAPI, "targets", `${t}.json`))).overlay)];
    for (const variant of names("variants/model")) {
      for (const voice of names("variants/voice")) {
        for (const target of targets) {
          const { assistant } = composeAssistant(base, {
            variant: read(join(VAPI, "variants/model", `${variant}.json`)),
            voice: read(join(VAPI, "variants/voice", `${voice}.json`)),
            target,
          });
          const built = buildDesiredAssistant(assistant, "P", [], { APP_URL: "https://x.example", VAPI_CREDENTIAL_ID: "c", APP_TIMEZONE: "America/New_York" });
          const label = `${variant}/${voice}/${String(built.name)}`;
          expect(built.serverMessages, label).toContain("phone-call-control");
          expect((built.monitorPlan as JsonObject | undefined)?.controlEnabled, label).not.toBe(false);
          expect((built.server as JsonObject).url, label).toBe("https://x.example/api/vapi/events");
        }
      }
    }
  });
});
