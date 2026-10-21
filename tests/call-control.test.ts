// Goodbye tail padding: Vapi delegates every hang-up to us (phone-call-control); we wait, then
// end the call through monitor.controlUrl. See src/server/vapi/call-control.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HANGUP_TAIL_MS, handlePhoneCallControl, type CallControlDeps } from "@/server/vapi/call-control";
import { handleEventsRequest } from "@/server/vapi/http";
import { buildDesiredAssistant, renderSystemPrompt, type JsonObject } from "@/vapi-sync/render";
import { composeAssistant, MAIN_TARGET, parseTarget } from "@/vapi-sync/variants";
import { post, TEST_SECRET, testRepos } from "./helpers";

const CONTROL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-123/control";

function fakeControl(opts: { failFirst?: boolean } = {}) {
  const events: string[] = [];
  let failed = false;
  const deps: CallControlDeps = {
    tailMs: DEFAULT_HANGUP_TAIL_MS,
    async post(url, body) {
      if (opts.failFirst && !failed) {
        failed = true;
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

const hangUp = (over: JsonObject = {}) => ({ type: "phone-call-control", request: "hang-up", call: { id: "call-123", monitor: { controlUrl: CONTROL } }, ...over });

describe("handlePhoneCallControl", () => {
  it("hang-up: waits the tail (1.5 s by default), then ends the call via the control URL", async () => {
    const { deps, events } = fakeControl();
    const out = handlePhoneCallControl(hangUp(), deps);
    expect(out.handled).toBe("hang-up");
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["sleep 1500", 'post controlUrl {"type":"end-call"}']);
    expect(DEFAULT_HANGUP_TAIL_MS).toBeGreaterThanOrEqual(1000); // covers the measured 0.67 s early hang-up + carrier tail
  });

  it("retries the end-call once if the control URL fails", async () => {
    const { deps, events } = fakeControl({ failFirst: true });
    const out = handlePhoneCallControl(hangUp(), deps);
    expect(out.handled !== "ignored" && (await out.done)).toBe(true);
    expect(events).toEqual(["sleep 1500", "post-failed end-call", "sleep 500", 'post controlUrl {"type":"end-call"}']);
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
  it("answers phone-call-control at once and ends the call after the tail", async () => {
    const { deps, events } = fakeControl();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: CallControlDeps = { ...deps, sleep: async (ms) => (events.push(`sleep ${ms}`), gate) };
    const res = await handleEventsRequest(post("/api/vapi/events", { message: hangUp() }, `Bearer ${TEST_SECRET}`), {
      secret: TEST_SECRET,
      repos: testRepos,
      callControl: slow,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: "hang-up" });
    expect(events).toEqual(["sleep 1500"]); // responded before hanging up
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["sleep 1500", 'post controlUrl {"type":"end-call"}']);
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
