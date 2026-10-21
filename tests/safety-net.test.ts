// Defense in depth for safety (eval run 1e753a02): a deterministic matcher over the caller's own
// words escalates triage, blocks emergency bookings, and reconciles after the call. Real lines
// from the failing transcripts are the fixtures.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dispatchItem } from "@/server/console/board";
import { dispatchRequests } from "@/server/db/schema";
import { EMERGENCY_NOT_BOOKABLE_SAY } from "@/server/services/book-appointment";
import { callerText, reconcileSafety } from "@/server/services/safety-reconcile";
import { callerLines, detectSignals, hasSignals, signalPhrases } from "@/server/triage/detect";
import type { BoardDispatchRow } from "@/server/repositories";
import { estimateCostUsd } from "@/vapi-sync/evals";
import { renderSystemPrompt } from "@/vapi-sync/render";
import { handleEventsRequest } from "@/server/vapi/http";
import { callTool as callToolAt, post, slotFactory, TEST_NOW, testDb, testDeps, testRepos } from "./helpers";

const makeSlot = slotFactory(10);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const triage = (over: Record<string, unknown> = {}) => ({
  caller_description: "",
  issue_type: "no_cooling",
  gas_smell: false,
  co_alarm: false,
  burning_smell_or_smoke: false,
  vulnerable_occupants: ["elderly"],
  property_type: "residential",
  zip: "11432",
  ...over,
});

describe("the matcher (caller's words only, negation-aware, escalate-only)", () => {
  it("finds the live misses", () => {
    expect(detectSignals("My grandmother is really hot, she's kind of confused and not making sense.").medical).toEqual(["she's kind of confused", "not making sense"]);
    expect(detectSignals("She's just really hot and confused, but she's breathing okay and she's awake.").medical).toEqual(["really hot and confused"]);
    expect(detectSignals("my carbon monoxide alarm started beeping about ten minutes ago").co).toEqual(["carbon monoxide alarm"]);
    expect(detectSignals("it smells kind of like rotten eggs near the basement").gas).toEqual(["rotten eggs"]);
    expect(detectSignals("My husband and I both have bad headaches and feel dizzy").co).toEqual(["headaches + dizzy"]);
    expect(detectSignals("there's smoke coming from the furnace").smoke).toEqual(["smoke"]);
    for (const t of ["he passed out in the kitchen", "she's having trouble breathing", "my dad has chest pain", "I think it's heat stroke", "she's unresponsive"]) {
      expect(detectSignals(t).medical.length, t).toBeGreaterThan(0);
    }
  });

  it("ignores negations, the caller's own confusion, and ordinary HVAC talk", () => {
    for (const t of [
      "No, there's no gas smell and no carbon monoxide alarm.",
      "No, I don't smell gas and there's no alarm going off.",
      "She's not having trouble breathing or chest pain",
      "The AC is blowing warm air, nobody is dizzy",
      "No smoke or burning smell",
      "I'm confused about my bill",
      "My furnace is making a banging noise and the gas furnace is old",
      "The thermostat display is blank",
      "the pilot light flame keeps going out on the boiler",
    ]) {
      expect(hasSignals(detectSignals(t)), t).toBe(false);
    }
  });

  it("reads only the caller's lines of a transcript (Ava asks about gas and CO on every call)", () => {
    const transcript = "AI: Do you smell gas, or is a carbon monoxide alarm going off?\nUser: No. My grandma is dizzy though.\nAI: Please call nine one one now.";
    expect(callerLines(transcript)).toBe("No. My grandma is dizzy though.");
    expect(signalPhrases(detectSignals(callerLines(transcript)))).toEqual(['medical: "dizzy"']);
  });
});

describe("triage_issue escalates on the caller's words even when the model's flags miss", () => {
  it("live 1e753a02: 'confused and not making sense' with no medical flag → priority dispatch, 911 first", async () => {
    const { payload } = await callTool(
      "triage_issue",
      triage({ caller_description: "AC died this morning, 92 degrees inside. My grandmother is really hot, she's kind of confused and not making sense." }),
    );
    expect(payload).toMatchObject({ ok: true, urgency: "emergency", next_action: "priority_dispatch" });
    expect(payload.detected_signals).toEqual(['medical: "she\'s kind of confused"', 'medical: "not making sense"']);
    expect(payload.reasons).toContain(`Detected in the caller's words: medical: "she's kind of confused", medical: "not making sense"`);
    expect(payload.say).toMatch(/^Medical emergency signs: if you haven't already, tell them in one calm sentence to call nine one one now/);
    // Triage logged the priority request itself; the say confirms the callback instead of demanding another tool.
    expect(payload).toMatchObject({ priority_request_logged: true });
    expect(payload.say).toMatch(/the priority request is already logged/i);
    expect(payload).not.toHaveProperty("offered_slots");
  });

  it("gas or CO in the description forces a safety stop and records it", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool("triage_issue", triage({ caller_description: "furnace isn't working and it smells like rotten eggs", vulnerable_occupants: [] }), { callId });
    expect(payload).toMatchObject({ ok: true, urgency: "safety_stop", next_action: "safety_instructions", office_followup_recorded: true });
    const rows = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(rows).toHaveLength(1);
  });

  it("a negated description changes nothing", async () => {
    const { payload } = await callTool("triage_issue", triage({ caller_description: "AC out since morning. No gas smell, nobody is dizzy.", vulnerable_occupants: [] }));
    expect(payload).not.toHaveProperty("detected_signals");
    expect(payload.urgency).not.toBe("emergency");
  });
});

describe("book_appointment never books an emergency", () => {
  it("refuses after an emergency triage on the call (live: heat stroke was booked)", async () => {
    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", triage({ medical_emergency: true }), { callId });
    const slot = await makeSlot({ county: "Queens", capacity: 3, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      { slot_id: slot.id, caller_confirmed: true, first_name: "Hector", last_name: "Alvarenga-Stout", address: { line1: "164-20 Highland Ave", zip: "11432" }, service_type: "diagnostic", urgency: "urgent", issue_summary: "Central AC stopped working" },
      { callId, callerNumber: "+13475550110" },
    );
    expect(payload).toMatchObject({ ok: false, error_code: "emergency_not_bookable", triage_urgency: "emergency", say: EMERGENCY_NOT_BOOKABLE_SAY });
    expect(EMERGENCY_NOT_BOOKABLE_SAY).toBe("This is an emergency: tell them to call 911 now if anyone is in danger, then create_priority_dispatch. Don't book an appointment.");
  });

  it("refuses when the booking's own description shows the signs, even without a triage flag", async () => {
    const slot = await makeSlot({ county: "Queens", capacity: 3, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      { slot_id: slot.id, caller_confirmed: true, first_name: "Hector", last_name: "Alvarenga-Stout", address: { line1: "164-20 Highland Ave", zip: "11432" }, service_type: "diagnostic", urgency: "urgent", issue_summary: "No AC, grandmother is very hot and confused" },
      { callerNumber: "+13475550110" },
    );
    expect(payload).toMatchObject({ ok: false, error_code: "emergency_not_bookable" });
  });
});

describe("post-call safety reconciliation", () => {
  const report = (callId: string, transcript: string) => ({
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      startedAt: "2026-10-22T14:00:00.000Z",
      endedAt: "2026-10-22T14:03:00.000Z",
      call: { id: callId, customer: { number: "+17185550901" } },
      artifact: { transcript },
    },
  });
  // Live 1e753a02 "refuses to leave": the script was given three times, no tool was ever called.
  const refuses =
    "User: Hi, um, my carbon monoxide alarm started beeping about ten minutes ago at 45 Bayview Terrace in Staten Island.\nAI: Oh no. Please leave the house right now…\nUser: I'm not going outside, it's freezing.";

  it("creates one auto-detected safety stop when the call has no record, idempotently", async () => {
    const callId = `call-${randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const res = await handleEventsRequest(post("/api/vapi/events", report(callId, refuses)), testDeps());
      expect(res.status).toBe(200);
    }
    const rows = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgency: "safety_stop", status: "open", callerPhone: "+17185550901" });
    expect(rows[0].reasons[0]).toBe('Auto-detected from transcript: CO: "carbon monoxide alarm"');
    expect(rows[0].intake).toMatchObject({ auto_detected: true, source: "transcript_reconciliation", flags: { co_alarm: true } });
  });

  it("medical signs become an emergency; a call that already has a record or no signs gets nothing new", async () => {
    const medical = await reconcileSafety({ vapiCallId: `call-${randomUUID()}`, callerPhone: "+17185550902", transcript: "User: my grandmother is really hot and confused", rawReport: {} }, testRepos());
    expect(medical).toMatchObject({ created: true, detected: ['medical: "really hot and confused"'] });
    const [row] = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.id, medical.dispatchId!));
    expect(row.urgency).toBe("emergency");

    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", triage({ gas_smell: true }), { callId });
    const already = await reconcileSafety({ vapiCallId: callId, callerPhone: null, transcript: "User: it smells like gas in here", rawReport: {} }, testRepos());
    expect(already).toMatchObject({ created: false, reason: "already recorded" });
    expect(await testDb().select().from(dispatchRequests).where(and(eq(dispatchRequests.vapiCallId, callId)))).toHaveLength(1);

    const quiet = await reconcileSafety({ vapiCallId: `call-${randomUUID()}`, callerPhone: null, transcript: "AI: Do you smell gas?\nUser: No, nothing like that.", rawReport: {} }, testRepos());
    expect(quiet).toMatchObject({ created: false, reason: "no signals" });
  });

  it("falls back to the report's user messages when there's no transcript", () => {
    expect(callerText({ transcript: null, rawReport: { artifact: { messages: [{ role: "bot", message: "gas?" }, { role: "user", message: "rotten eggs smell" }] } } })).toBe("rotten eggs smell");
  });

  it("the board card and call detail know it was auto-detected", () => {
    const item = dispatchItem({ id: "d", urgency: "safety_stop", reasons: [], status: "open", callerName: null, callerPhone: null, address: null, intake: { auto_detected: true }, customerName: null, customerPhone: null, createdAt: new Date(), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolution: null, resolutionNote: null, resolvedBy: null, vapiCallId: "c", isDemoSeed: false } satisfies BoardDispatchRow, new Date());
    expect(item.autoDetected).toBe(true);
  });
});

describe("prompt and evals", () => {
  const p = renderSystemPrompt(readFileSync(join(process.cwd(), "vapi/system-prompt.md"), "utf8"), { transferAvailable: false, timeZone: "America/New_York" });

  it("lists the medical signs, says 911 first, and triages in the same turn as any safety script", () => {
    expect(p).toContain("Medical emergency signs in anyone at home: confused or not making sense, disoriented, dizzy, fainting or passed out, unresponsive, trouble breathing or not breathing, chest pain");
    expect(p).toContain('your very next words are "Please call nine one one now,"');
    expect(p).toContain("even if they haven't agreed to leave yet or are still talking");
    expect(p).toContain("Always pass caller_description: the caller's own words about the problem and the people at home, close to verbatim.");
  });

  it("--iterations multiplies the estimate: the 9 safety scenarios twice ≈ $1.80 on chat", () => {
    expect(estimateCostUsd(9, "vapi.webchat", 2)).toBe(1.8);
  });
});
