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
    expect(messages.some((m) => m.type === "request-start" && m.content.length < 60)).toBe(true);
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

  it("Ava persona: warm, contractions, no parroting, says she's an AI", () => {
    expect(p).toContain("You are Ava, Summit Air's virtual assistant");
    expect(p).toMatch(/You're an AI\. If anyone asks whether you're a real person, say so plainly/);
    expect(p).toContain("Use contractions");
    expect(p).toContain("Never parrot the caller's words back");
    expect(p).toContain("Oh no, sorry to hear that. Before anything else, do you smell gas, or is a carbon monoxide alarm going off?");
  });

  it("lookup_customer (caller ID) comes right after the safety screen, before location", () => {
    const safety = p.indexOf("2. Safety screen");
    const lookup = p.indexOf("3. Right after the safety screen, before asking where they are or anything else, call lookup_customer with no arguments");
    const location = p.indexOf("5. Location.");
    expect(safety).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(safety);
    expect(location).toBeGreaterThan(lookup);
    expect(p).toContain("if they give a street address instead of a ZIP, accept that and don't push for the ZIP first");
  });

  it("empty results, 'No result returned' and any error are failures → apologize once, then a callback", () => {
    expect(p).toContain('an empty result, "No result returned", a timeout, an error message of any kind');
    expect(p).toContain("Treat it as a failure even if it's labeled as completed successfully");
    expect(p).toContain("apologize once");
    expect(p).toContain("call create_callback_request with reason backend_failure");
    expect(p).toContain("don't try a different way to look them up");
  });

  it("assistant: greeting, temperature, voice settings and keyterms", () => {
    expect(assistantFile.firstMessage).toBe("Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?");
    expect((assistantFile.model as JsonObject).temperature).toBe(0.5);
    const voice = assistantFile.voice as JsonObject;
    expect(voice.provider).toEqual(expect.any(String));
    expect(voice.voiceId).toEqual(expect.any(String));
    expect(voice).not.toHaveProperty("fillerInjectionEnabled"); // removed from Vapi's API
    expect(((voice.chunkPlan as JsonObject).punctuationBoundaries as string[])).not.toContain(",");
    const keyterm = (assistantFile.transcriber as JsonObject).keyterm as string[];
    for (const t of ["AC", "A/C", "air conditioner", "no heat", "no AC"]) expect(keyterm).toContain(t);
    expect(keyterm.length).toBeLessThanOrEqual(100); // Deepgram's limit
    expect(new Set(keyterm).size).toBe(keyterm.length);
  });
});

describe("assistant rendering", () => {
  it("fills prompt, sorted tool ids, events server and strips _comments", () => {
    const a = buildDesiredAssistant(assistantFile, "PROMPT ${NOT_A_VAR}", ["b", "a"], ENV);
    expect(a).not.toHaveProperty("_comments");
    expect(a.server).toEqual({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
    expect(a.serverMessages).toEqual(["end-of-call-report", "status-update"]);
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

  it("technician intake is gathered naturally, one at a time, skipping what's known, never as a checklist", () => {
    expect(off).toContain("# What the technician needs");
    expect(off).toContain("one question at a time");
    expect(off).toContain("Skip anything the caller already told you, and never run through them like a checklist");
    for (const item of ["When it started", "brand or rough age", "thermostat setting and mode", "breaker", "error code", "Pets", "read it back in groups"]) {
      expect(off).toContain(item);
    }
    expect(off).toContain("Include symptoms, onset, equipment, tried steps, error code, pets, access notes, on-site contact and vulnerable occupants");
  });

  it("residential is never silently assumed; businesses declined; multi-unit central systems go to the office", () => {
    expect(off).not.toContain("Assume residential");
    expect(off).toContain("Never silently assume what kind of property it is");
    expect(off).toContain('"And this is for your home, right?"');
    expect(off).toContain("A landlord or property manager calling about a single apartment or house is residential");
    expect(off).toContain("multi_unit_central_system true");
    expect(off).toContain("office_review");
  });

  it("members: benefits only when relevant; one Comfort Club mention, never on urgent/emergency/safety calls", () => {
    expect(off).toContain("Only after verified is true: if they're an active member, mention their benefits briefly");
    expect(off).toContain("Never mention Comfort Club on urgent, emergency or safety calls, and never push it");
  });

  it("calling for someone else: on-site contact separate, verification never blocks booking, vulnerability is about the occupants", () => {
    expect(off).toContain("# Calling for someone else");
    expect(off).toContain("on_site_contact");
    expect(off).toContain("It never blocks booking service at a new address");
    expect(off).toContain("about whoever lives at the service address");
  });

  it("existing appointments: verified only; reschedule/cancel become an honest office callback", () => {
    expect(off).toContain("never confirm an appointment to an unverified caller");
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
    expect(off).toContain("You may state only the diagnostic fee and the membership prices");
    expect(off).toContain("the technician gives a quote on site");
  });

  it("corrections after the read-back are read back again before booking", () => {
    expect(off).toContain("If they correct anything after the read-back");
    expect(off).toContain("get a fresh yes before you book. Never book on the old details.");
  });
});
