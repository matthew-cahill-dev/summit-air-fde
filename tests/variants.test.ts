import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesiredAssistant, renderSystemPrompt, type JsonObject, type SyncEnv } from "@/vapi-sync/render";
import { applyOverlay, composeAssistant, DEFAULT_SELECTION, getPath, MAIN_TARGET, parseTarget } from "@/vapi-sync/variants";

const VAPI = join(process.cwd(), "vapi");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as JsonObject;
const base = read(join(VAPI, "assistant.json"));
const template = readFileSync(join(VAPI, "system-prompt.md"), "utf8");
const ENV: SyncEnv = { APP_URL: "https://summit.example.app", VAPI_CREDENTIAL_ID: "cred-123", APP_TIMEZONE: "America/New_York" };
const files = (dir: string) =>
  existsSync(join(VAPI, dir)) ? readdirSync(join(VAPI, dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
const models = files("variants/model");
const voices = files("variants/voice");
const targets = files("targets");

describe("applyOverlay", () => {
  it("merges objects, replaces arrays and scalars, deletes on null, ignores _comments", () => {
    const { result, removed } = applyOverlay(
      { a: { b: 1, c: 2 }, list: [1, 2], keep: true, gone: { x: 1 } },
      { _comments: "x", a: { b: 9 }, list: [3], gone: null, nope: null, added: "y" },
    );
    expect(result).toEqual({ a: { b: 9, c: 2 }, list: [3], keep: true, added: "y" });
    expect(removed).toEqual(["gone"]); // "nope" wasn't there
  });

  it("reports nested deletions by dotted path, readable with getPath", () => {
    const { removed } = applyOverlay({ startSpeakingPlan: { smartEndpointingPlan: { provider: "livekit" }, waitSeconds: 0.4 } }, { startSpeakingPlan: { smartEndpointingPlan: null } });
    expect(removed).toEqual(["startSpeakingPlan.smartEndpointingPlan"]);
    expect(getPath({ startSpeakingPlan: { smartEndpointingPlan: { provider: "livekit" } } }, removed[0])).toEqual({ provider: "livekit" });
  });

  it("the default selection is assistant.json unchanged", () => {
    expect(DEFAULT_SELECTION).toEqual({ variant: "gpt-4.1", voice: "emma", target: "main" });
    const { assistant, removed } = composeAssistant(base, {
      variant: read(join(VAPI, "variants/model/gpt-4.1.json")),
      voice: read(join(VAPI, "variants/voice/emma.json")),
      target: MAIN_TARGET.overlay,
    });
    expect(assistant).toEqual(base);
    expect(removed).toEqual([]);
  });
});

describe("targets never point at the live phone assistant", () => {
  it("rejects VAPI_ASSISTANT_ID and bad env names", () => {
    expect(() => parseTarget("x", { assistantIdEnv: "VAPI_ASSISTANT_ID" })).toThrow(/must not point at the main assistant/);
    expect(() => parseTarget("x", { assistantIdEnv: "lowercase" })).toThrow(/env var name/);
  });

  it.each(targets)("%s has its own assistant id variable", (name) => {
    const t = parseTarget(name, read(join(VAPI, "targets", `${name}.json`)));
    expect(t.assistantIdEnv).not.toBe("VAPI_ASSISTANT_ID");
  });
});

describe.each(models.flatMap((variant) => voices.map((voice) => [variant, voice])))("variant %s + voice %s", (variant, voice) => {
  const { assistant } = composeAssistant(base, {
    variant: read(join(VAPI, "variants/model", `${variant}.json`)),
    voice: read(join(VAPI, "variants/voice", `${voice}.json`)),
    target: MAIN_TARGET.overlay,
  });
  const built = buildDesiredAssistant(assistant, "PROMPT", ["t1"], ENV);

  it("renders a complete assistant with the same tools, server and call ending", () => {
    const model = built.model as JsonObject;
    expect(model.toolIds).toEqual(["t1"]);
    expect(typeof model.model).toBe("string");
    expect((model.messages as JsonObject[])[0]).toEqual({ role: "system", content: "PROMPT" });
    expect(built.server).toEqual(base.server === undefined ? undefined : { url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
    expect(built.endCallPhrases).toEqual(base.endCallPhrases);
    expect((model.tools as JsonObject[]).find((t) => t.type === "endCall")).toEqual((base.model as JsonObject).tools && ((base.model as JsonObject).tools as JsonObject[]).find((t) => t.type === "endCall"));
  });

  it("keeps 'Ava' pronounced as AY-vuh", () => {
    expect(built.firstMessage).toContain("Ayva");
    const v = built.voice as JsonObject;
    const replacements = (((v.chunkPlan as JsonObject | undefined)?.formatPlan as JsonObject | undefined)?.replacements ?? []) as Array<{ regex?: string; key?: string; value: string }>;
    const ava = replacements.find((r) => r.regex?.includes("Ava") || r.key === "Ava");
    expect(ava, "every voice must respell Ava").toBeDefined();
    expect((v.chunkPlan as JsonObject).enabled).toBe(true);
  });
});

describe("the S2S target (a separate assistant)", () => {
  const target = parseTarget("s2s", read(join(VAPI, "targets/s2s.json")));
  const { assistant, removed } = composeAssistant(base, {
    variant: read(join(VAPI, "variants/model/gpt-4.1.json")),
    voice: read(join(VAPI, "variants/voice/emma.json")),
    target: target.overlay,
  });
  const built = buildDesiredAssistant(assistant, "PROMPT", ["t2", "t1"], ENV);

  it("is OpenAI Realtime speech-to-speech with an OpenAI voice and no transcriber or TTS settings", () => {
    expect(target.assistantIdEnv).toBe("VAPI_S2S_ASSISTANT_ID");
    expect(target.promptFlags).toEqual({ S2S: true });
    expect(built.name).toBe("Summit Air – S2S");
    expect(built.model).toMatchObject({ provider: "openai", model: "gpt-realtime-2", toolIds: ["t1", "t2"] });
    expect(built.model).not.toHaveProperty("temperature");
    expect(built).not.toHaveProperty("transcriber");
    expect(built.voice).toEqual({ provider: "openai", voiceId: "marin" });
    expect(removed).toEqual(expect.arrayContaining(["transcriber", "voice.chunkPlan", "voice.version"]));
  });

  it("shares the tools' server, the events URL, the call ending and the padded hang-up with main", () => {
    expect(built.server).toEqual({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
    expect(built.serverMessages).toContain("phone-call-control");
    expect(built.endCallPhrases).toEqual(base.endCallPhrases);
    expect(((built.model as JsonObject).tools as JsonObject[])[0]).toMatchObject({ type: "endCall" });
  });

  it("the S2S prompt adds word-for-word safety, spoken read-backs and pre-tool words; main doesn't", () => {
    const s2s = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York", flags: { S2S: true } });
    const main = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });
    for (const line of [
      "Say it word for word, at a calm, steady pace.",
      "Before calling a tool, say one or two words",
      "You hear audio, not a transcript: before using an address, ZIP or phone number, read it back",
      "Never switch languages because of an accent",
    ]) {
      expect(s2s).toContain(line);
      expect(main).not.toContain(line);
    }
    expect(main).toContain("Your voice starts on that first short sentence");
    expect(s2s).not.toContain("Your voice starts on that first short sentence");
    // Every other rule is shared.
    expect(s2s).toContain("Please leave the house right now");
    expect(s2s).toContain("call endCall immediately");
  });
});

describe("the S2S target prompt", () => {
  it("renders with the S2S flag on and off, without placeholders", () => {
    for (const S2S of [false, true]) {
      const p = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York", flags: { S2S } });
      expect(p).not.toMatch(/<<|>>/);
    }
  });
});
