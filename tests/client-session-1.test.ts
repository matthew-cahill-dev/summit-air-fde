// Client session 1 (live call 01a165a4, Oct 22 2026): "Not doing too well tonight" and "super hot"
// went unasked and the call was booked as routine no-AC; the gas/CO question was asked on an AC
// call; the call was long (first times at 2:32); and the caller's name was never read back.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appointments, customers, dispatchRequests } from "@/server/db/schema";
import { bookedSay } from "@/server/services/book-appointment";
import { concernSay, HEATING_SCREEN_SAY, prioritySay } from "@/server/services/triage-issue";
import { detectConcerns, detectSignals, hasSignals, involvesHeatingEquipment } from "@/server/triage/detect";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";

const makeSlot = slotFactory(13);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });
// Customers aren't truncated between runs, so every booking test gets a fresh number.
const freshPhone = () => `+1718${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
const triage = (over: Record<string, unknown> = {}) => ({ issue_type: "no_cooling", property_type: "residential", zip: "11215", ...over });
const SESSION_1_WORDS = "Not doing too well tonight. It's just super hot outside, um, but I don't have any AC. It's blowing warm air.";

describe("possible distress is asked about, never silently booked (client session 1)", () => {
  it("detectConcerns finds the session-1 phrases, but they aren't emergency signals on their own", () => {
    expect(detectConcerns(SESSION_1_WORDS)).toEqual(["not doing too well", "super hot"]);
    expect(hasSignals(detectSignals(SESSION_1_WORDS))).toBe(false);
    for (const t of ["I'm feeling really sick", "we can't take the heat anymore", "my husband has a headache", "it's freezing in here"]) {
      expect(detectConcerns(t), t).not.toEqual([]);
    }
    for (const t of ["the AC stopped working", "it's not super hot today, just warm", "everyone's fine, nothing like that", ""]) {
      expect(detectConcerns(t), t).toEqual([]);
    }
  });

  it("triage asks the one gentle question before offering times, and stays routine", async () => {
    const { payload } = await callTool("triage_issue", triage({ caller_description: SESSION_1_WORDS }));
    expect(payload).toMatchObject({ ok: true, possible_concerns: ["not doing too well", "super hot"] });
    expect(payload.urgency).not.toBe("emergency");
    const say = payload.say as string;
    expect(say).toContain(concernSay(["not doing too well", "super hot"]));
    expect(say).toContain('"Is anyone at home feeling unwell, like dizzy, confused or having trouble breathing?"');
    expect(say).toContain("call triage_issue again with medical_emergency true");
    expect(say.indexOf("feeling unwell")).toBeLessThan(say.indexOf("Next: offer these windows now"));

    const calm = await callTool("triage_issue", triage({ caller_description: "AC stopped working, everyone is fine" }));
    expect(calm.payload.possible_concerns).toBeUndefined();
    expect(calm.payload.say).not.toContain("feeling unwell");
  });

  it("a yes re-triages as a medical emergency: 911 first, the priority request logged", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool("triage_issue", triage({ caller_description: SESSION_1_WORDS, medical_emergency: true }), { callId });
    expect(payload).toMatchObject({ ok: true, urgency: "emergency", next_action: "priority_dispatch", priority_request_logged: true });
    expect(payload.possible_concerns).toBeUndefined();
  });
});

describe("gas and carbon monoxide are asked on heating calls only (client session 1)", () => {
  it("involvesHeatingEquipment: no heat or fuel-burning equipment, never AC", () => {
    expect(involvesHeatingEquipment("no_heat", "")).toBe(true);
    expect(involvesHeatingEquipment("noise", "the boiler is banging")).toBe(true);
    expect(involvesHeatingEquipment("noise", "the furnace makes a weird noise")).toBe(true);
    expect(involvesHeatingEquipment("no_cooling", "AC blowing warm air")).toBe(false);
    expect(involvesHeatingEquipment("maintenance", "tune-up for the central air")).toBe(false);
  });

  it("an AC call triages with no safety flags at all, and nothing about gas or CO comes back", async () => {
    const { payload } = await callTool("triage_issue", triage({ caller_description: "AC stopped working" }));
    expect(payload).toMatchObject({ ok: true, next_action: expect.stringMatching(/^book_/), safety_not_reported: ["gas_smell", "co_alarm", "burning_smell_or_smoke"] });
    expect(payload.heating_safety_screen).toBeUndefined();
    expect(payload.say).not.toMatch(/gas|carbon monoxide/i);
  });

  it("a heating call where gas and CO never came up: the result asks for the check before times", async () => {
    const { payload } = await callTool("triage_issue", triage({ issue_type: "no_heat", caller_description: "heat stopped working two days ago" }));
    expect(payload).toMatchObject({ ok: true, heating_safety_screen: true });
    expect(payload.say).toContain(HEATING_SCREEN_SAY);
    expect((payload.say as string).indexOf("do you smell gas")).toBeLessThan((payload.say as string).indexOf("Next: offer these windows now"));

    // Already asked and answered: no second time.
    const asked = await callTool("triage_issue", triage({ issue_type: "no_heat", gas_smell: false, co_alarm: false, caller_description: "heat stopped working" }));
    expect(asked.payload.heating_safety_screen).toBeUndefined();
    expect(asked.payload.say).not.toContain(HEATING_SCREEN_SAY);
  });

  it("a gas smell the caller volunteers still stops everything, with no flags sent", async () => {
    const { payload } = await callTool("triage_issue", triage({ issue_type: "no_heat", caller_description: "the heat's out and I smell gas", zip: undefined }));
    expect(payload).toMatchObject({ ok: true, urgency: "safety_stop", next_action: "safety_instructions" });
  });
});

describe("emergencies get off the phone faster (client session 1)", () => {
  it("an emergency triage never waits for lookup_customer; a routine one still does", async () => {
    const emergency = await callTool("triage_issue", triage({ issue_type: "no_heat", indoor_temp_f: 50 }), { noLookup: true });
    expect(emergency.payload).toMatchObject({ ok: true, urgency: "emergency", next_action: "priority_dispatch" });
    const routine = await callTool("triage_issue", triage({ caller_description: "AC stopped working" }), { noLookup: true });
    expect(routine.payload).toMatchObject({ ok: false, error_code: "lookup_required" });
  });

  it("triage logs a non-medical priority request itself; create_priority_dispatch adds to the same one", async () => {
    const callId = `call-${randomUUID()}`;
    const callerNumber = freshPhone();
    const { payload } = await callTool("triage_issue", triage({ issue_type: "no_heat", indoor_temp_f: 50, caller_description: "no heat, it's 50 inside" }), { callId, callerNumber });
    expect(payload).toMatchObject({ next_action: "priority_dispatch", priority_request_logged: true });
    expect(payload.say).toContain("The priority request is already logged for the on-call team.");
    expect(payload.say).toContain("Can the on-call team call you back at the number you're calling from?");
    let rows = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgency: "emergency", status: "open" });

    const added = await callTool(
      "create_priority_dispatch",
      { first_name: "Regina", last_name: "Lewis", address: { line1: "123 Main Street", zip: "11215" }, issue_summary: "no heat, 50 inside" },
      { callId, callerNumber },
    );
    expect(added.payload).toMatchObject({ ok: true, updated_existing: true });
    rows = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(rows).toHaveLength(1);
  });

  it("prioritySay: confirm, don't interview", () => {
    const verified = prioritySay({ recorded: true, hasPhone: true, verified: true, offerTransfer: false });
    expect(verified).not.toContain("name and the street address");
    expect(verified).toContain("Ask nothing else");
    expect(prioritySay({ recorded: true, hasPhone: false, verified: false, offerTransfer: false })).toContain("get their name and the street address");
    // The database failed at triage: create_priority_dispatch is what logs it.
    expect(prioritySay({ recorded: false, hasPhone: true, verified: false, offerTransfer: true })).toContain("that logs the priority request");
  });
});

describe("the caller's name is said back and can be corrected (client session 1)", () => {
  const booking = (slotId: string, first: string, last: string) => ({
    slot_id: slotId,
    caller_confirmed: true,
    first_name: first,
    last_name: last,
    address: { line1: "123 Main Street", zip: "11215" },
    service_type: "diagnostic",
    urgency: "routine",
    issue_summary: "AC blowing warm air and making weird noises",
  });

  it("the booking result says the name back; a correction on the same call fixes the customer and the notes", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    const callerNumber = freshPhone();
    const first = await callTool("book_appointment", booking(slot.id, "Regina", "Louis"), { callId, callerNumber });
    expect(first.payload).toMatchObject({ ok: true, new_customer: true });
    expect(first.payload.say).toContain("under the name Regina Louis. Say the name so they can catch a mistake");

    const fixed = await callTool("book_appointment", booking(slot.id, "Regina", "Lewis"), { callId, callerNumber });
    expect(fixed.payload).toMatchObject({ ok: true, already_booked: true, name_corrected: true, appointment_id: first.payload.appointment_id });
    expect(fixed.payload.say).toContain("Same booking, name fixed: it's now under Regina Lewis.");
    const [customer] = await testDb().select().from(customers).where(eq(customers.phoneE164, callerNumber));
    expect(customer).toMatchObject({ firstName: "Regina", lastName: "Lewis" });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, first.payload.appointment_id as string));
    expect(appt.technicianNotes).toContain("for Regina Lewis");
  });

  it("a different name on a later call never renames the account: it's kept on the visit instead", async () => {
    const callerNumber = freshPhone();
    const earlier = await makeSlot({ capacity: 3, booked: 0 });
    await callTool("book_appointment", booking(earlier.id, "Morgan", "Hale"), { callerNumber });
    const later = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool("book_appointment", booking(later.id, "Jordan", "Price"), { callerNumber });
    expect(payload).toMatchObject({ ok: true, new_customer: false });
    expect(payload.name_corrected).toBeUndefined();
    const [customer] = await testDb().select().from(customers).where(eq(customers.phoneE164, callerNumber));
    expect(customer).toMatchObject({ firstName: "Morgan", lastName: "Hale" });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.intake).toMatchObject({ caller_stated_name: "Jordan Price" });
  });

  it("bookedSay: a verified caller's stored name is never read out", () => {
    const base = { already: false, moved: false, detailsUpdated: false, window: "Friday between 1 and 5 PM", address: { line1: "37-12 82nd St", unit: null }, offerMembership: false };
    expect(bookedSay({ ...base, name: null })).not.toContain("under the name");
    expect(bookedSay({ ...base, name: "Regina Lewis" })).toContain("under the name Regina Lewis");
  });
});
