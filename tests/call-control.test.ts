// Goodbye tail: Vapi delegates every hang-up to us (phone-call-control); we answer at once, then
// end the call through monitor.controlUrl a fixed 0.4 s after the goodbye. See src/server/vapi/call-control.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANGUP_SEND_DELAY_MS,
  goodbyeEndAt,
  handlePhoneCallControl,
  hangupDelayMs,
  MAX_SEND_AFTER_GOODBYE_MS,
  RETRY_DELAYS_MS,
  type CallControlDeps,
} from "@/server/vapi/call-control";
import { handleEventsRequest } from "@/server/vapi/http";
import { buildDesiredAssistant, renderSystemPrompt, type JsonObject } from "@/vapi-sync/render";
import { composeAssistant, MAIN_TARGET, parseTarget } from "@/vapi-sync/variants";
import { post, TEST_SECRET, testRepos } from "./helpers";

const CONTROL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-123/control";

/** Records every step; `defer` queues the end-call so tests can check it runs only after the answer. */
function fakeControl(opts: { failFirst?: number; now?: number } = {}) {
  const events: string[] = [];
  const deferred: Array<() => Promise<unknown>> = [];
  let failures = opts.failFirst ?? 0;
  const deps: CallControlDeps = {
    sendDelayMs: DEFAULT_HANGUP_SEND_DELAY_MS,
    now: () => opts.now ?? NOW,
    async post(url, body) {
      if (failures > 0) {
        failures--;
        events.push(`post-failed ${String(body.type)}`);
        throw new Error("HTTP 400");
      }
      events.push(`post ${url === CONTROL ? "controlUrl" : url} ${JSON.stringify(body)}`);
    },
    async sleep(ms) {
      events.push(`sleep ${ms}`);
    },
    defer(task) {
      events.push("deferred");
      deferred.push(task);
    },
  };
  const flush = async () => {
    while (deferred.length) await deferred.shift()!();
  };
  return { deps, events, flush };
}

const NOW = 1_792_589_000_000;
const hangUp = (over: JsonObject = {}) => ({ type: "phone-call-control", request: "hang-up", call: { id: "call-123", monitor: { controlUrl: CONTROL } }, ...over });

describe("ending order: goodbye in full → answer Vapi at once → end-call a fixed 0.4 s after the goodbye", () => {
  // Measured Oct 21 (Vapi logs + SIP pcaps): Vapi accepts our end-call only after we've answered
  // its hang-up request. Holding the answer until end-call succeeded deadlocked (502 → re-deliveries
  // → line open ~11 s). Answered first + end-call 1.5 s later: BYE 3.57 s after the goodbye.

  it("anchors on Vapi's send time (= goodbye end): a request that arrives 0.3 s late waits only 0.1 s more", () => {
    expect(hangupDelayMs(hangUp({ timestamp: NOW - 300 }), 400, NOW)).toBe(100);
    expect(hangupDelayMs(hangUp({ timestamp: NOW - 900 }), 400, NOW)).toBe(0); // late arrival: send now
  });

  it("hard guard: the first end-call never waits past 1 s after the goodbye, whatever is configured", () => {
    expect(MAX_SEND_AFTER_GOODBYE_MS).toBe(1000);
    expect(hangupDelayMs(hangUp({ timestamp: NOW }), 5000, NOW)).toBe(1000);
  });

  it("ignores implausible anchors (clock skew, stale redelivery) and counts from receipt", () => {
    expect(goodbyeEndAt(hangUp({ timestamp: NOW - 60_000 }), NOW)).toBeNull();
    expect(hangupDelayMs(hangUp({ timestamp: NOW - 60_000 }), 400, NOW)).toBe(400);
    expect(hangupDelayMs(hangUp(), 400, NOW)).toBe(400);
  });

  it("the end-call is deferred until after the answer, then sent after the computed delay", async () => {
    const { deps, events, flush } = fakeControl();
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW - 300 }), deps);
    expect(out).toMatchObject({ handled: "hang-up", delayMs: 100 });
    expect(events).toEqual(["deferred"]); // nothing sent yet
    await flush();
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["deferred", "sleep 100", 'post controlUrl {"type":"end-call"}']);
  });
});

describe("hang-up failsafe", () => {
  it("retries quickly when Vapi rejects the end-call (our answer may not have landed yet): 4 attempts", async () => {
    const { deps, events, flush } = fakeControl({ failFirst: 2 });
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW - 1000 }), deps);
    await flush();
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["deferred", "post-failed end-call", "sleep 250", "post-failed end-call", "sleep 500", 'post controlUrl {"type":"end-call"}']);
    expect(RETRY_DELAYS_MS).toEqual([250, 500, 1000]);
  });

  it("reports failure when every attempt fails (logged; call-report shows the late teardown)", async () => {
    const { deps, flush } = fakeControl({ failFirst: 4 });
    const out = handlePhoneCallControl(hangUp({ timestamp: NOW - 1000 }), deps);
    await flush();
    expect(out.handled !== "ignored" && (await out.done)).toBe(false);
  });

  it("forward: transfers right after the answer (delegated forwarding keeps transfers working)", async () => {
    const { deps, events, flush } = fakeControl();
    const destination = { type: "number", number: "+17185550100" };
    const out = handlePhoneCallControl(hangUp({ request: "forward", destination }), deps);
    await flush();
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["deferred", `post controlUrl ${JSON.stringify({ type: "transfer", destination })}`]);
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

  it("answers phone-call-control 200 at once, BEFORE the end-call (regression: holding it deadlocked)", async () => {
    const { deps, events, flush } = fakeControl();
    const res = await send(hangUp({ timestamp: NOW - 400 }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: "hang-up" });
    expect(events).toEqual(["deferred"]); // the end-call hasn't gone out yet
    await flush();
    expect(events).toEqual(["deferred", 'post controlUrl {"type":"end-call"}']);
  });

  it("never answers 5xx: a failing end-call or a missing control URL is logged, not re-delivered", async () => {
    const failing = fakeControl({ failFirst: 4 });
    expect((await send(hangUp({ timestamp: NOW }), failing.deps)).status).toBe(200);
    await failing.flush();
    const res = await send({ type: "phone-call-control", request: "hang-up", call: { id: "x" } }, fakeControl().deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, handled: "ignored" });
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
