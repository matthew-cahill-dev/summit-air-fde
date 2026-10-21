import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bookAppointmentSchema } from "@/server/services/book-appointment";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
import { nonStringEnumPaths, vapiParameters, type JsonSchemaNode } from "@/vapi-sync/parameters";
import {
  buildDesiredAssistant,
  buildDesiredTools,
  renderSystemPrompt,
  substituteVars,
  toolName,
  type JsonObject,
  type SyncEnv,
} from "@/vapi-sync/render";

const VAPI_DIR = join(process.cwd(), "vapi");
const toolFiles = readdirSync(join(VAPI_DIR, "tools"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(VAPI_DIR, "tools", f), "utf8")) as JsonObject);
const template = readFileSync(join(VAPI_DIR, "system-prompt.md"), "utf8");
const assistantFile = JSON.parse(readFileSync(join(VAPI_DIR, "assistant.json"), "utf8")) as JsonObject;

const ENV: SyncEnv = { APP_URL: "https://summit.example.app/", VAPI_CREDENTIAL_ID: "cred-123", APP_TIMEZONE: "America/New_York" };

type Schema = JsonSchemaNode;

/** Compare the parts of a JSON schema the model relies on: property names, types, required, enums, nesting. */
function shape(s: Schema | undefined): unknown {
  if (!s) return null;
  // Zod emits "integer" for z.number().int(); either is fine for Vapi.
  const type = s.type === "integer" ? "number" : (s.type ?? null);
  if (s.properties) {
    return {
      type,
      props: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(v)])),
      required: [...(s.required ?? [])].sort(),
    };
  }
  if (s.items) return { type, items: shape(s.items) };
  return { type, enum: s.enum ? [...s.enum].sort() : null };
}

describe("vapi/tools/*.json", () => {
  const functionTools = toolFiles.filter((t) => t.type === "function");

  it("has one function tool per server tool, and nothing unregistered", () => {
    expect(functionTools.map(toolName).sort()).toEqual(Object.keys(TOOL_REGISTRY).sort());
  });

  it.each(Object.keys(TOOL_REGISTRY))("%s parameters match the server's Zod schema", (name) => {
    const file = functionTools.find((t) => toolName(t) === name)!;
    const fromZod = vapiParameters(TOOL_REGISTRY[name].schema);
    const fromFile = (file.function as { parameters: Schema }).parameters;
    expect(shape(fromFile)).toEqual(shape(fromZod));
  });

  it.each(functionTools.map((t) => [toolName(t), t] as const))("%s has only string enums (Vapi rejects others)", (_name, t) => {
    expect(nonStringEnumPaths((t.function as { parameters: Schema }).parameters)).toEqual([]);
  });

  it("z.literal(true) is sent to Vapi as a plain boolean; the server still enforces true", () => {
    expect(z.toJSONSchema(z.literal(true))).toMatchObject({ type: "boolean", const: true });
    const params = vapiParameters(bookAppointmentSchema);
    expect(params.properties!.caller_confirmed).toEqual({ type: "boolean" });
    expect(nonStringEnumPaths(params)).toEqual([]);
    const file = functionTools.find((t) => toolName(t) === "book_appointment")!;
    const fileField = (file.function as { parameters: Schema }).parameters.properties!.caller_confirmed;
    expect(fileField).toEqual({ type: "boolean", description: expect.any(String) });

    const base = bookAppointmentSchema.safeParse({ caller_confirmed: false });
    expect(base.success).toBe(false);
    expect(base.error!.issues.find((i) => i.path[0] === "caller_confirmed")?.message).toContain("must be true");
  });

  it("string literals and enums are kept as string enums", () => {
    const params = vapiParameters(z.object({ a: z.literal("x"), b: z.enum(["p", "q"]), c: z.literal(3) }));
    expect(params.properties).toEqual({ a: { type: "string", enum: ["x"] }, b: { type: "string", enum: ["p", "q"] }, c: { type: "number" } });
  });

  it.each(toolFiles.map((t) => [toolName(t), t] as const))("%s has request-start filler and no secrets", (_name, t) => {
    const messages = t.messages as Array<{ type: string; content: string }>;
    const starts = messages.filter((m) => m.type === "request-start");
    expect(starts.length).toBeGreaterThan(0);
    // Short: the filler starts ~1.1 s after the tool call (measured) and should finish before the result.
    // (A transfer's "please stay on the line" is a handoff instruction, not a wait filler.)
    if (t.type !== "transferCall") for (const m of starts) expect(m.content.split(/\s+/).length, m.content).toBeLessThanOrEqual(5);
    // Never hint that an account exists before verification.
    expect(JSON.stringify(starts)).not.toMatch(/account/i);
    // Non-blocking, so the filler plays the moment the tool is called, while it runs.
    expect(messages.filter((m) => (m as { blocking?: boolean }).blocking)).toEqual([]);
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/sk-|Bearer |\+1\d{10}/);
  });

  it("function tools point at the tools endpoint with the credential, filled at sync time", () => {
    for (const t of buildDesiredTools(toolFiles, ENV).filter((x) => x.type === "function")) {
      expect(t.server).toEqual({ url: "https://summit.example.app/api/vapi/tools", credentialId: "cred-123", timeoutSeconds: 10 });
    }
  });

  it("transfer tool is attached only with ON_CALL_TRANSFER_NUMBER, as a blind transfer to that number", () => {
    expect(buildDesiredTools(toolFiles, ENV).map(toolName)).not.toContain("transfer_to_on_call");
    const withTransfer = buildDesiredTools(toolFiles, { ...ENV, ON_CALL_TRANSFER_NUMBER: "+17185550100" });
    const transfer = withTransfer.find((t) => toolName(t) === "transfer_to_on_call")!;
    expect(transfer).toMatchObject({
      type: "transferCall",
      destinations: [{ type: "number", number: "+17185550100", transferPlan: { mode: "blind-transfer" } }],
    });
  });
});

describe("system prompt rendering", () => {
  const off = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });
  const on = renderSystemPrompt(template, { transferAvailable: true, timeZone: "America/New_York" });

  it("fills business facts and leaves no sync placeholders", () => {
    for (const p of [off, on]) {
      expect(p).not.toMatch(/<<|>>|<!--/);
      expect(p).toContain("$129 for a diagnostic visit");
      // The office number is fictional: never given to callers.
      expect(p).not.toMatch(/555|zero one zero zero/);
      expect(p).toContain("call back on this same number");
      expect(p).toContain("within 15 minutes");
    }
  });

  it("keeps Vapi Liquid for runtime", () => {
    expect(off).toContain('{{"now" | date: "%A, %B %d, %Y, %I:%M %p", "America/New_York"}}');
    expect(off).toContain("{% if caller_recognized %}");
  });

  it("switches the transfer instructions on ON_CALL_TRANSFER_NUMBER", () => {
    expect(on).toContain("use transfer_to_on_call");
    expect(on).not.toContain("Live transfer isn't available");
    expect(off).toContain("Live transfer isn't available");
    expect(off).not.toContain("transfer_to_on_call");
  });

  it("includes the safety script and utility numbers", () => {
    expect(off).toContain("Please leave the house right now");
    expect(off).toContain("Summit Air has NOT called 911");
    expect(off).toContain("National Grid, seven one eight, six four three, four zero five zero");
    expect(off).toContain("one eight hundred, seven five two, six six three three");
  });

  it("rejects unknown placeholders", () => {
    expect(() => renderSystemPrompt("Hi <<NOPE>>", { transferAvailable: false, timeZone: "UTC" })).toThrow("Unknown prompt placeholder <<NOPE>>");
  });
});

describe("identity rules in the prompt", () => {
  const p = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });
  it("never reads stored details back before verification", () => {
    expect(p).toContain("Never read back, hint at, or confirm any stored name, address, membership or equipment before verified is true");
    expect(p).not.toMatch(/I have you at/);
    expect(assistantFile.firstMessage).not.toMatch(/\{\{/);
  });
});

describe("persona, call flow and failure handling (live-call fixes)", () => {
  const p = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });

  it("Ava persona: warm, contractions, no parroting, says she's an AI, short example exchanges", () => {
    expect(p).toContain("You are Ava, Summit Air's virtual assistant");
    expect(p).toMatch(/You're an AI\. If anyone asks whether you're a real person, say so plainly/);
    expect(p).toContain("contractions");
    expect(p).toContain("Never parrot the caller");
    expect(p).toContain("Apologize at most once per problem");
    expect(p).toContain("After verification, use their first name once");
    // Rhythm examples: discourse markers, safety screen, casual recap.
    expect(p).toContain("Ava: Oh no. Before anything else, do you smell gas, or is a carbon monoxide alarm going off?");
    // Latency: a one-to-three-word opener is its own sentence, so TTS can start on it.
    expect(p).toContain('Start most replies with a one-to-three-word sentence of its own ("Got it." "Okay." "Oh no."');
    expect(p).toContain("Ava: Okay, so I've got you today between one and five at thirty-seven twelve eighty-second street, for the AC. Sound good?");
    expect(p.match(/^Ava: /gm)).toHaveLength(3);
  });

  it("call order: safety → lookup (residential only) → follow each tool result's next step → recap → book once", () => {
    const at = (s: string) => {
      const i = p.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const order = [
      at("2. Safety screen"),
      at("3. Right after the safety screen, call lookup_customer with no arguments (caller ID) before asking anything else."),
      at("4. From then on, follow the next step in each tool result's say. Ask technician questions only when a tool tells you to."),
      at("5. Before booking, recap as one casual sentence"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain("call book_appointment once, with caller_confirmed true and everything they told you");
  });

  it("empty results, 'No result returned' and any error are failures → apologize once, then a callback", () => {
    expect(p).toContain('an empty result, "No result returned", a timeout, an error message of any kind');
    expect(p).toContain("Treat it as a failure even if it's labeled as completed successfully");
    expect(p).toContain("apologize once");
    expect(p).toContain("call create_callback_request with reason backend_failure");
    expect(p).toContain("don't try a different way to look them up");
  });

  it("the per-call Liquid sits at the very end, so the rest is a cacheable prefix", () => {
    const dynamic = p.indexOf("{{");
    expect(dynamic).toBeGreaterThan(p.length - 400);
    expect(p.indexOf("{%")).toBeGreaterThan(dynamic);
    expect(p.lastIndexOf("# ")).toBe(p.indexOf("# This call"));
  });

  it("assistant: greeting, temperature, voice settings and keyterms", () => {
    // "Ava" is spelled phonetically for the TTS (live transcripts heard "Eva").
    expect(assistantFile.firstMessage).toBe("Hi, thanks for calling Summit Air! This is Ayva, the virtual assistant. What's going on today?");
    expect((assistantFile.model as JsonObject).temperature).toBe(0.5);
    const voice = assistantFile.voice as JsonObject;
    expect(voice.provider).toEqual(expect.any(String));
    expect(voice.voiceId).toEqual(expect.any(String));
    expect(voice).not.toHaveProperty("fillerInjectionEnabled"); // removed from Vapi's API
    const chunkPlan = voice.chunkPlan as JsonObject;
    expect(chunkPlan.enabled).toBe(true); // replacements need it
    expect((chunkPlan.punctuationBoundaries as string[])).not.toContain(",");
    const replacements = (chunkPlan.formatPlan as JsonObject).replacements as Array<{ type: string; regex: string; value: string }>;
    for (const r of replacements) {
      expect(r.type).toBe("regex");
      expect(() => new RegExp(r.regex)).not.toThrow();
    }
    expect("This is Ava speaking".replace(new RegExp(replacements[0].regex), replacements[0].value)).toBe("This is Ayva speaking");
    const keyterm = (assistantFile.transcriber as JsonObject).keyterm as string[];
    for (const t of ["AC", "A/C", "air conditioner", "no heat", "Navien", "Weil-McLain", "Daikin", "Lennox", "Rheem", "Burnham", "Jackson Heights"]) expect(keyterm).toContain(t);
    expect(keyterm.length).toBeLessThanOrEqual(50); // Deepgram advises 20-50 keyterms (500-token cap)
    expect(new Set(keyterm).size).toBe(keyterm.length);
    expect(assistantFile.backgroundSound).toBe("off"); // Vapi's phone default is "office"
  });

  it("turn-taking: Deepgram Flux end-of-turn ('fast' preset values, the default), no dead endpointing config", () => {
    expect(assistantFile.transcriber).toMatchObject({ provider: "deepgram", model: "flux-general-en", language: "en", eotThreshold: 0.7, eotTimeoutMs: 3000 });
    const plan = assistantFile.startSpeakingPlan as JsonObject;
    // Vapi: don't set smartEndpointingPlan with Flux; custom rules and transcriptionEndpointingPlan are ignored.
    expect(plan).toEqual({ waitSeconds: 0.2 });
    expect(assistantFile._removedFromLive).toEqual([
      "startSpeakingPlan.smartEndpointingPlan",
      "startSpeakingPlan.customEndpointingRules",
      "startSpeakingPlan.transcriptionEndpointingPlan",
    ]);
    expect(assistantFile.stopSpeakingPlan).toMatchObject({ numWords: 2, acknowledgementPhrases: expect.arrayContaining(["uh-huh", "mm-hmm"]) });
    expect((assistantFile.voice as JsonObject).chunkPlan).toMatchObject({ enabled: true, minCharacters: 5 });
    expect((assistantFile.model as JsonObject).promptCacheRetention).toBe("24h");
  });

  it("call endings: endCall speaks one closing line (blocking), which ends in the only end-call phrase", () => {
    const tools = (assistantFile.model as JsonObject).tools as Array<{ type: string; messages?: Array<{ type: string; content: string; blocking?: boolean }> }>;
    const endCall = tools.find((t) => t.type === "endCall")!;
    const [goodbye] = endCall.messages!;
    expect(goodbye).toEqual({ type: "request-start", content: "Thanks for calling Summit Air. Take care, and goodbye for now.", blocking: true });
    expect(assistantFile.endCallMessage).toBe(goodbye.content);
    const phrases = assistantFile.endCallPhrases as string[];
    expect(phrases).toEqual(["goodbye for now"]);
    for (const ph of phrases) {
      expect(goodbye.content.toLowerCase()).toContain(ph);
      // An end-call phrase anywhere else would hang up mid-call (they match any assistant speech).
      expect((assistantFile.firstMessage as string).toLowerCase()).not.toContain(ph);
      expect(p.toLowerCase()).not.toContain(ph);
      for (const t of toolFiles) expect(JSON.stringify(t).toLowerCase()).not.toContain(ph);
    }
    expect(p).toContain("call endCall immediately. Don't say goodbye, thanks or take care yourself");
    expect(p).toContain("After a goodbye, never start talking again. Ignore stray single words, numbers or noises.");
    expect(p).toContain("Wait for them to acknowledge, then end the call");
    expect(p).toContain("Never end the call while the safety instructions are still being said");
    expect(p).toContain('ask "Is there anything else I can help with?"');
  });
});

describe("assistant rendering", () => {
  it("fills prompt, sorted tool ids, events server and strips _comments", () => {
    const a = buildDesiredAssistant(assistantFile, "PROMPT ${NOT_A_VAR}", ["b", "a"], ENV);
    expect(a).not.toHaveProperty("_comments");
    expect(a.server).toMatchObject({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
    expect(a.serverMessages).toEqual(["end-of-call-report", "status-update", "phone-call-control"]);
    expect(a.monitorPlan).toEqual({ controlEnabled: true }); // the control URL the padded hang-up uses
    // Hang-up failsafe: Vapi re-delivers a failed phone-call-control (or any message); max 10-minute calls.
    expect((a.server as JsonObject).backoffPlan).toEqual({ type: "exponential", maxRetries: 3, baseDelaySeconds: 1 });
    expect(a.maxDurationSeconds).toBe(600);
    expect(a).not.toHaveProperty("_defaults");
    expect(a).not.toHaveProperty("_removedFromLive");
    const model = a.model as JsonObject;
    expect(model).toMatchObject({ provider: "openai", model: "gpt-4.1", toolIds: ["a", "b"] });
    // The prompt text is inserted verbatim, never re-scanned for ${...}.
    expect((model.messages as JsonObject[])[0]).toEqual({ role: "system", content: "PROMPT ${NOT_A_VAR}" });
  });

  it("missing variables are an error, never sent", () => {
    expect(() => substituteVars({ a: "${APP_URL}/x" }, {})).toThrow("Missing value for ${APP_URL}");
  });
});

describe("M5 prompt rules: requirements and the unexpected", () => {
  const off = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });
  const on = renderSystemPrompt(template, { transferAvailable: true, timeZone: "America/New_York" });

  it("technician intake: no checklist in the prompt (live: seeing it early made Ava ask it before triage); the tool result asks for it", () => {
    expect(off).not.toContain("# What the technician needs");
    expect(off).not.toMatch(/thermostat mode and setting|brand or rough age/);
    // The checklist now arrives with the offered windows (see robustness-batch.test.ts).
    expect(off).toContain("Ask technician questions only when a tool tells you to.");
  });

  it("property type: confirmed only when unclear; businesses skip lookup; multi-unit central systems go to the office", () => {
    expect(off).not.toContain("Assume residential");
    expect(off).toContain('"My house", "my home", "my apartment" or "lives with me" means residential. Don\'t ask to confirm it.');
    expect(off).toContain('Only when it\'s genuinely unclear, ask naturally: "And this is for your home, right?"');
    expect(off).toContain("A landlord or property manager calling about one apartment or house is residential");
    expect(off).toContain("multi_unit_central_system true");
    expect(off).toContain("office_review");
    expect(off).toContain("skip lookup_customer and call triage_issue now with property_type commercial");
  });

  it("verified callers are never re-asked for anything on the account (live: ZIP, house/apartment, home?, last name)", () => {
    expect(off).toContain("Never ask again for anything on it or already said: name, last name, phone, ZIP, house or apartment, unit, or property type");
    expect(off).toContain('don\'t ask "this is for your home, right?"');
    expect(off).toContain("leave out name, phone and address; they come from the account");
  });

  it("no invented facts, policies, credentials or services; commercial declines use business facts only", () => {
    expect(off).toContain("Never give reasons, policies, licenses, insurance, credentials, guarantees or services that aren't there");
    expect(off).toContain("never offer a service, referral or follow-up that isn't");
    expect(off).toContain("using only the business facts, say kindly that Summit Air only services homes, so they'll want a commercial HVAC company");
    expect(off).toContain("Commercial callers: we don't refer them to other companies.");
  });

  it("callbacks: one per call, preferred time, new numbers read back before submitting", () => {
    expect(off).toContain("One callback request per call");
    expect(off).toContain("preferred_callback_time");
    expect(off).toContain("Before you submit a number that isn't the one they're calling from, read it back in groups and get a yes");
  });

  it("members: benefits only when relevant; one Comfort Club mention, never on urgent/emergency/safety calls", () => {
    expect(off).toContain("Only once verified: if they're an active member, mention member_benefits briefly when relevant");
    expect(off).toContain("Never mention Comfort Club on urgent, emergency or safety calls, and never push it");
  });

  it("calling for someone else: on-site contact separate, verification never blocks booking, vulnerability is about the occupants", () => {
    expect(off).toContain("# Calling for someone else");
    expect(off).toContain("on_site_contact");
    expect(off).toContain("It never blocks booking service at a new address");
    expect(off).toContain("about whoever lives at the service address");
  });

  it("existing appointments: verified only; reschedule/cancel become an honest office callback", () => {
    expect(off).toContain("Never confirm an appointment to an unverified caller");
    expect(off).toContain("you can't change bookings by phone");
    expect(off).toContain("the office will call to confirm the change");
  });

  it("other languages: English then simple Spanish, then a callback with the language", () => {
    expect(off).toContain("first in English and then in simple Spanish");
    expect(off).toContain("La oficina le va a llamar en español");
    expect(off).toContain("language set to their language");
  });

  it("human requests: warm callback when transfer is off, immediate transfer offer when it's on", () => {
    expect(off).toContain("don't refuse or argue");
    expect(off).toContain("reason human_requested");
    expect(on).toContain("If the caller asks for a person, offer to connect them right away");
    expect(on).toContain("offer the transfer right after create_priority_dispatch succeeds");
  });

  it("non-service and abusive calls end politely; prices limited to configured fees", () => {
    expect(off).toContain("Wrong numbers, sales or vendor pitches, robocalls and job applicants: one polite sentence");
    expect(off).toContain("set one calm boundary");
    expect(off).toContain("Prices: only the diagnostic fee and the membership prices");
    expect(off).toContain("the technician quotes on site");
  });

  it("corrections after the recap are recapped again before booking", () => {
    expect(off).toContain("If they correct anything after the recap");
    expect(off).toContain("get a fresh yes before you book. Never book on the old details.");
  });
});

describe("Oct 21 morning call fixes (prompt)", () => {
  const p = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });

  it("clarifies a word that doesn't fit instead of repeating it (live: 'make sure' heard as 'Mercury')", () => {
    expect(p).toContain("If a word or phrase doesn't make sense in context, you probably misheard it. Never repeat it back or guess what it means.");
    expect(p).toContain('"Sorry, I didn\'t catch that, could you say it again?"');
  });

  it("keeps turns short (live: 8-14 s turns drew 4 barge-ins)", () => {
    expect(p).toContain("one or two short sentences per turn (about 25 words at most)");
    expect(p).toContain("A recap is one sentence.");
  });

  it("one outcome per call; expedite only on request; exact times become a note, never a callback", () => {
    expect(p).toContain("Once a booking is confirmed, don't create a callback unless the caller explicitly asks for something the booking doesn't cover");
    expect(p).toContain("Don't offer to have the office try for sooner; log an expedite callback");
    expect(p).toContain("only if the caller asks for sooner");
    expect(p).toContain("call book_appointment again with the same slot_id and arrival_preference");
    expect(p).toContain("Never a callback for this.");
  });
});
