// Live call 01a15f51 (Oct 21): asked how long a furnace tune-up takes, Ava invented a duration;
// asked what it costs, she quoted the $129 diagnostic fee. Both now come from business facts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS } from "@/config/business";
import { businessFactsText, renderSystemPrompt } from "@/vapi-sync/render";

const prompt = renderSystemPrompt(readFileSync(join(process.cwd(), "vapi/system-prompt.md"), "utf8"), { transferAvailable: false, timeZone: "America/New_York" });
const source = readFileSync(join(process.cwd(), "src/config/business.ts"), "utf8");

describe("tune-up price and visit length are business facts (ASSUMPTION), not improvised", () => {
  it("the facts state a tune-up price separate from the diagnostic fee, and visit lengths", () => {
    const facts = businessFactsText();
    expect(facts).toContain("- Diagnostic fee (diagnostic and repair visits only): $129 for a diagnostic or repair visit, waived for active Comfort Club members.");
    expect(facts).toContain("- Tune-up (maintenance) price: A tune-up is $149 per system for non-members. Comfort Club members get one heating and one cooling tune-up a year included.");
    expect(facts).toContain("- Visit length: A tune-up usually takes about an hour. Diagnostic and repair visits vary; the technician will say how long once they've seen the system.");
    expect(BUSINESS.facts.tuneUpPrice).not.toContain("129");
    expect(source).toMatch(/\/\/ ASSUMPTION: tune-up \(maintenance\) price/);
    expect(source).toMatch(/\/\/ ASSUMPTION: visit lengths/);
  });

  it("the prompt matches the price to the visit type and never guesses a duration", () => {
    expect(prompt).toContain("a tune-up or maintenance visit gets the tune-up price (never the diagnostic fee); a diagnostic or repair visit gets the diagnostic fee.");
    expect(prompt).toContain("How long a visit takes: only the visit-length fact. Never guess a duration.");
    expect(prompt).toContain("$149 per system for non-members");
  });

  it("membership facts agree: the tune-ups members get are the ones the price says are included", () => {
    expect(BUSINESS.facts.membershipPlans[0]).toContain("One heating and one cooling tune-up a year");
    expect(BUSINESS.facts.tuneUpPrice).toContain("one heating and one cooling tune-up a year included");
  });
});

describe("default ending", () => {
  it("is controlled (our server hangs up); native-padded is only an A/B flag", () => {
    const assistant = JSON.parse(readFileSync(join(process.cwd(), "vapi/assistant.json"), "utf8")) as { _defaults: Record<string, string>; serverMessages: string[] };
    expect(assistant._defaults.ending).toBe("controlled");
    expect(assistant.serverMessages).toContain("phone-call-control");
  });
});
