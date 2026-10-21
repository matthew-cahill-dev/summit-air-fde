import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesiredAssistant, renderSystemPrompt, type JsonObject, type SyncEnv } from "@/vapi-sync/render";
import { applyOverlay, composeAssistant, DEFAULT_SELECTION, defaultSelection, getPath, MAIN_TARGET, parseTarget } from "@/vapi-sync/variants";

const VAPI = join(process.cwd(), "vapi");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as JsonObject;
const base = read(join(VAPI, "assistant.json"));
const template = readFileSync(join(VAPI, "system-prompt.md"), "utf8");
const ENV: SyncEnv = { APP_URL: "https://summit.example.app", VAPI_CREDENTIAL_ID: "cred-123", APP_TIMEZONE: "America/New_York" };
const files = (dir: string) =>
  existsSync(join(VAPI, dir)) ? readdirSync(join(VAPI, dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
const models = files("variants/model");
const voices = files("variants/voice");
const endpointings = files("variants/endpointing");
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

  it("the default selection comes from assistant.json _defaults, and composing it changes nothing", () => {
    expect(DEFAULT_SELECTION).toEqual({ variant: "gpt-4.1", voice: "emma", endpointing: "fast", ending: "controlled", target: "main" });
    const defaults = defaultSelection(base);
    expect(defaults).toEqual({ variant: "gpt-4.1", voice: "emma", endpointing: "fast", ending: "controlled", target: "main" });
    // Every default names an existing overlay file.
    expect(models).toContain(defaults.variant);
    expect(voices).toContain(defaults.voice);
    expect(endpointings).toContain(defaults.endpointing);
    const { assistant, removed } = composeAssistant(base, {
      variant: read(join(VAPI, `variants/model/${defaults.variant}.json`)),
      voice: read(join(VAPI, `variants/voice/${defaults.voice}.json`)),
      endpointing: read(join(VAPI, `variants/endpointing/${defaults.endpointing}.json`)),
      ending: read(join(VAPI, `variants/ending/${defaults.ending}.json`)),
      target: MAIN_TARGET.overlay,
    });
    expect(assistant).toEqual(base); // assistant.json is written with the default preset's values
    expect(removed).toEqual([]);
  });

  it("falls back to DEFAULT_SELECTION when _defaults is missing or partial", () => {
    expect(defaultSelection({})).toEqual(DEFAULT_SELECTION);
    expect(defaultSelection({ _defaults: { voice: "xai-liora" } })).toEqual({ ...DEFAULT_SELECTION, voice: "xai-liora" });
  });
});

describe("endpointing presets (--endpointing fast|safe)", () => {
  const preset = (name: string) => composeAssistant(base, { variant: {}, voice: {}, endpointing: read(join(VAPI, `variants/endpointing/${name}.json`)), target: {} }).assistant;

  it("exist as fast and safe, with fast the default (live Oct 21: fast beat safe at p95 2054 vs 2941 ms)", () => {
    expect(endpointings.sort()).toEqual(["fast", "safe"]);
    expect(defaultSelection(base).endpointing).toBe("fast");
  });

  it("safe trades a little speed for fewer cut-ins: higher Flux confidence and a longer silence backstop", () => {
    const fast = preset("fast");
    const safe = preset("safe");
    expect(fast.transcriber).toMatchObject({ model: "flux-general-en", eotThreshold: 0.7, eotTimeoutMs: 3000 });
    expect(safe.transcriber).toMatchObject({ model: "flux-general-en", eotThreshold: 0.8, eotTimeoutMs: 4000 });
    expect(fast.startSpeakingPlan).toEqual({ waitSeconds: 0.2 });
    expect(safe.startSpeakingPlan).toEqual({ waitSeconds: 0.2 });
    for (const p of [fast, safe]) {
      const t = p.transcriber as JsonObject;
      expect(t.eotThreshold as number).toBeGreaterThanOrEqual(0.5); // Vapi's range
      expect(t.eotThreshold as number).toBeLessThanOrEqual(0.9);
      expect(t.eotTimeoutMs as number).toBeGreaterThanOrEqual(500);
      expect(t.eotTimeoutMs as number).toBeLessThanOrEqual(10_000);
    }
  });

  it("a pipeline variant can replace the transcriber over a preset (nova-3 gets no Flux fields)", () => {
    const { assistant } = composeAssistant(base, {
      variant: read(join(VAPI, "variants/model/gpt-4.1-nova3.json")),
      voice: {},
      endpointing: read(join(VAPI, "variants/endpointing/safe.json")),
      target: {},
    });
    expect(assistant.transcriber).toMatchObject({ model: "nova-3" });
    expect(assistant.transcriber).not.toHaveProperty("eotThreshold");
    expect(assistant.startSpeakingPlan).toMatchObject({ waitSeconds: 0.4, smartEndpointingPlan: { provider: "livekit" } });
  });
});

describe("xai-liora voice (copied from the sandbox assistant Riley)", () => {
  const { assistant, removed } = composeAssistant(base, { variant: {}, voice: read(join(VAPI, "variants/voice/xai-liora.json")), target: {} });
  const voice = assistant.voice as JsonObject;

  it("is exactly Riley's voice object plus our chunkPlan", () => {
    const { chunkPlan, ...rest } = voice;
    expect(rest).toEqual({ provider: "xai", voiceId: "liora", language: "auto" });
    expect(chunkPlan).toEqual((base.voice as JsonObject).chunkPlan);
    expect(removed).toEqual(expect.arrayContaining(["voice.version", "voice.speed"]));
  });

  it("keeps the Ayva respelling and a short first chunk", () => {
    const plan = voice.chunkPlan as JsonObject;
    expect(plan).toMatchObject({ enabled: true, minCharacters: 5 });
    const [ava] = (plan.formatPlan as JsonObject).replacements as Array<{ regex: string; value: string }>;
    expect("This is Ava".replace(new RegExp(ava.regex), ava.value)).toBe("This is Ayva");
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
    expect(built.server).toMatchObject({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
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
    expect(built.server).toMatchObject({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
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
