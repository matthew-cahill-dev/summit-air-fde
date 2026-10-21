import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
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

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema };

/** Compare the parts of a JSON schema the model relies on: property names, required, enums, nesting. */
function shape(s: Schema | undefined): unknown {
  if (!s) return null;
  if (s.properties) {
    return {
      props: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(v)])),
      required: [...(s.required ?? [])].sort(),
    };
  }
  if (s.items) return { items: shape(s.items) };
  return s.enum && typeof s.enum[0] === "string" ? { enum: [...s.enum].sort() } : null;
}

describe("vapi/tools/*.json", () => {
  const functionTools = toolFiles.filter((t) => t.type === "function");

  it("has one function tool per server tool, and nothing unregistered", () => {
    expect(functionTools.map(toolName).sort()).toEqual(Object.keys(TOOL_REGISTRY).sort());
  });

  it.each(Object.keys(TOOL_REGISTRY))("%s parameters match the server's Zod schema", (name) => {
    const file = functionTools.find((t) => toolName(t) === name)!;
    const fromZod = z.toJSONSchema(TOOL_REGISTRY[name].schema, { io: "input", unrepresentable: "any" }) as Schema;
    const fromFile = (file.function as { parameters: Schema }).parameters;
    expect(shape(fromFile)).toEqual(shape(fromZod));
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

describe("assistant rendering", () => {
  it("fills prompt, sorted tool ids, events server and strips _comments", () => {
    const a = buildDesiredAssistant(assistantFile, "PROMPT ${NOT_A_VAR}", ["b", "a"], ENV);
    expect(a).not.toHaveProperty("_comments");
    expect(a.server).toEqual({ url: "https://summit.example.app/api/vapi/events", credentialId: "cred-123" });
    expect(a.serverMessages).toEqual(["end-of-call-report"]);
    const model = a.model as JsonObject;
    expect(model).toMatchObject({ provider: "openai", model: "gpt-4.1", toolIds: ["a", "b"] });
    // The prompt text is inserted verbatim, never re-scanned for ${...}.
    expect((model.messages as JsonObject[])[0]).toEqual({ role: "system", content: "PROMPT ${NOT_A_VAR}" });
  });

  it("missing variables are an error, never sent", () => {
    expect(() => substituteVars({ a: "${APP_URL}/x" }, {})).toThrow("Missing value for ${APP_URL}");
  });
});
