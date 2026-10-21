// M5 requirement gaps: technician intake (d), residential vs multi-unit (b), membership
// (c), callers booking for someone else, next appointment, language callbacks.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BUSINESS } from "@/config/business";
import { callbackItem, dispatchItem } from "@/server/console/board";
import { appointments, callbackRequests, dispatchRequests } from "@/server/db/schema";
import type { BoardCallbackRow, BoardDispatchRow } from "@/server/repositories";
import { buildTechnicianNotes, intakeSentences } from "@/server/scheduling/technician-notes";
import { shouldOfferMembership } from "@/server/services/book-appointment";
import { triageRules, type TriageFlags } from "@/server/triage/rules";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";

const makeSlot = slotFactory(4);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const DANA = "00000000-0000-4000-8000-000000000001";
const IN_AREA = { zip: "11215", inArea: true, county: "Kings" };
const WINTER = { year: 2026, month: 1, day: 15 };
const SUMMER = { year: 2026, month: 7, day: 15 };
const flags = (over: Partial<TriageFlags> = {}): TriageFlags => ({
  issueType: "maintenance",
  gasSmell: false,
  coAlarm: false,
  burningSmellOrSmoke: false,
  vulnerableOccupants: [],
  propertyType: "residential",
  ...over,
});

function bookingArgs(slotId: string, over: Record<string, unknown> = {}) {
  return {
    slot_id: slotId,
    caller_confirmed: true,
    first_name: "Maria",
    last_name: "Alvarez",
    address: { line1: "55 Demo Ave", unit: "2F", city: "Brooklyn", zip: "11215" },
    service_type: "repair",
    urgency: "routine",
    issue_summary: "Boiler won't fire",
    symptoms: ["clicking then nothing"],
    ...over,
  };
}

describe("residential vs multi-unit central systems (triage)", () => {
  it.each([
    ["routine, central system", flags({ centralMultiUnit: true }), WINTER, "routine", "office_review"],
    ["urgent no heat, central system", flags({ issueType: "no_heat", centralMultiUnit: true }), WINTER, "urgent", "office_review"],
    ["emergency stays priority dispatch", flags({ issueType: "no_heat", vulnerableOccupants: ["elderly"], centralMultiUnit: true }), WINTER, "emergency", "priority_dispatch"],
    ["landlord, one apartment (not central)", flags({ issueType: "no_heat", centralMultiUnit: false }), WINTER, "urgent", "book_earliest"],
    ["safety stop beats everything", flags({ gasSmell: true, centralMultiUnit: true }), SUMMER, "safety_stop", "safety_instructions"],
  ] as const)("%s", (_name, f, today, urgency, nextAction) => {
    const d = triageRules(f, IN_AREA, today);
    expect([d.urgency, d.nextAction]).toEqual([urgency, nextAction]);
    if (f.centralMultiUnit && !f.gasSmell) expect(d.reasons).toContain("Building-wide central system serving multiple units: office to review");
  });

  it("commercial is still declined, central system or not", () => {
    expect(triageRules(flags({ propertyType: "commercial", centralMultiUnit: true }), IN_AREA, WINTER).nextAction).toBe("explain_and_close");
  });

  it("triage_issue returns office_review with the exact callback to log, and no slots", async () => {
    const { payload } = await callTool("triage_issue", {
      issue_type: "no_heat",
      gas_smell: false,
      co_alarm: false,
      burning_smell_or_smoke: false,
      property_type: "residential",
      multi_unit_central_system: true,
      zip: "11215",
    });
    expect(payload).toMatchObject({
      ok: true,
      next_action: "office_review",
      callback: { reason: "other", details: "multi-unit/central system, office to review" },
    });
    expect(payload).not.toHaveProperty("offered_slots");
    expect(payload.say).toMatch(/Don't book/);
  });

  it("multi_unit_central_system is optional and blank-tolerant", async () => {
    const { payload } = await callTool("triage_issue", {
      issue_type: "maintenance",
      gas_smell: false,
      co_alarm: false,
      burning_smell_or_smoke: false,
      property_type: "residential",
      multi_unit_central_system: "",
      zip: "11215",
    });
    expect(payload).toMatchObject({ ok: true, next_action: "book_standard" });
  });
});

describe("technician intake (book_appointment)", () => {
  it("stores onset, equipment, tried steps, error code and pets in intake and renders them for the technician", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      bookingArgs(slot.id, {
        onset: "since last night",
        equipment: "Weil-McLain gas boiler, about 15 years old",
        tried_steps: ["thermostat set to heat at 72", "reset the breaker"],
        error_code: "E4 on the display",
        pets: "one dog, will be crated",
        access_notes: "Buzzer 2F",
      }),
      { callerNumber: "+17185550501" },
    );
    expect(payload).toMatchObject({ ok: true, booked: true });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.intake).toMatchObject({
      onset: "since last night",
      equipment: "Weil-McLain gas boiler, about 15 years old",
      tried_steps: ["thermostat set to heat at 72", "reset the breaker"],
      error_code: "E4 on the display",
      pets: "one dog, will be crated",
      on_site_contact: null,
    });
    const notes = appt.technicianNotes!;
    // One paragraph, in the order a technician uses it.
    const order = ["Issue:", "Started: since last night.", "Symptoms:", "Equipment:", "Already tried: thermostat set to heat at 72; reset the breaker.", "Error code: E4 on the display.", "Pets: one dog, will be crated.", "Access: Buzzer 2F.", "Contact: (718) 555-0501."];
    const positions = order.map((s) => notes.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("calling for someone else: the on-site contact is separate from the caller, and an unverified caller can book a new address", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callerPhone = "+13475550502";
    const { payload } = await callTool(
      "book_appointment",
      bookingArgs(slot.id, {
        address: { line1: "12 Mother Ln", city: "Brooklyn", zip: "11215" },
        on_site_contact: { name: "Rosa Alvarez", phone: "718 555 0503", relationship: "caller's mother" },
        vulnerable_occupants: ["elderly"],
      }),
      { callerNumber: callerPhone },
    );
    expect(payload).toMatchObject({ ok: true, booked: true, new_customer: true });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.intake).toMatchObject({
      on_site_contact: { name: "Rosa Alvarez", phone: "+17185550503", relationship: "caller's mother" },
      vulnerable_occupants: ["elderly"],
    });
    expect(appt.technicianNotes).toContain("On-site contact: Rosa Alvarez (caller's mother), (718) 555-0503.");
    expect(appt.technicianNotes).toContain("Vulnerable occupants: elderly.");
    expect(appt.technicianNotes).toContain("Caller: (347) 555-0502.");
  });

  it("an empty on_site_contact object (or one without a name) counts as omitted", async () => {
    for (const [i, contact] of [{}, { name: "" }, { name: " ", phone: "" }].entries()) {
      const slot = await makeSlot({ capacity: 3, booked: 0 });
      const { payload } = await callTool("book_appointment", bookingArgs(slot.id, { on_site_contact: contact }), { callerNumber: `+1718555051${i}` });
      expect(payload, JSON.stringify(contact)).toMatchObject({ ok: true, booked: true });
    }
  });

  it("intakeSentences leaves out what wasn't said", () => {
    expect(intakeSentences({})).toEqual([]);
    expect(intakeSentences({ onset: "this morning", triedSteps: [] })).toEqual(["Started: this morning."]);
    const notes = buildTechnicianNotes({
      urgency: "routine",
      serviceType: "maintenance",
      customerName: "A B",
      isMember: false,
      phoneE164: null,
      address: { line1: "1 St", unit: null, city: "Brooklyn", zip: "11215" },
      windowLabel: "Thursday, October 22, between 8 and 10 AM",
      issueSummary: "Tune-up",
      accessNotes: null,
      vapiCallId: null,
    });
    expect(notes).toBe(
      "Property: Residential. ROUTINE maintenance for A B (non-member) at 1 St, Brooklyn, NY 11215. Arrival window: Thursday, October 22, between 8 and 10 AM. Issue: Tune-up. Access: none noted. Contact: not provided. Booked by the virtual assistant.",
    );
  });
});

describe("priority dispatch gets the same intake", () => {
  it("stores the intake and a technician paragraph for the on-call team", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool(
      "create_priority_dispatch",
      {
        first_name: "Maria",
        address: { line1: "12 Mother Ln", zip: "11215" },
        issue_type: "no_heat",
        issue_summary: "No heat, mother is 84",
        onset: "since yesterday afternoon",
        equipment: "oil boiler",
        tried_steps: ["checked thermostat"],
        on_site_contact: { name: "Rosa Alvarez", relationship: "caller's mother" },
        vulnerable_occupants: ["elderly"],
        reasons: ["No heat during heat season (Oct 1 to May 31) with vulnerable occupants: elderly"],
      },
      { callId, callerNumber: "+13475550520" },
    );
    expect(payload).toMatchObject({ ok: true, status: "open" });
    const [row] = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(row.intake).toMatchObject({
      onset: "since yesterday afternoon",
      equipment: "oil boiler",
      tried_steps: ["checked thermostat"],
      on_site_contact: { name: "Rosa Alvarez", phone: null, relationship: "caller's mother" },
      technician_notes:
        "Property: Residential. Started: since yesterday afternoon. Equipment: oil boiler. Already tried: checked thermostat. Vulnerable occupants: elderly. On-site contact: Rosa Alvarez (caller's mother).",
    });

    // The board card shows that paragraph.
    const item = dispatchItem({ ...(row as unknown as BoardDispatchRow), customerName: null, customerPhone: null }, TEST_NOW);
    expect(item.notes).toContain("On-site contact: Rosa Alvarez");
  });
});

describe("membership", () => {
  it.each([
    [{ isMember: false, urgency: "routine", serviceType: "maintenance", vulnerableOccupants: [] }, true],
    [{ isMember: true, urgency: "routine", serviceType: "maintenance", vulnerableOccupants: [] }, false],
    [{ isMember: false, urgency: "urgent", serviceType: "maintenance", vulnerableOccupants: [] }, false],
    [{ isMember: false, urgency: "routine", serviceType: "repair", vulnerableOccupants: [] }, false],
    [{ isMember: false, urgency: "routine", serviceType: "maintenance", vulnerableOccupants: ["elderly"] }, false],
  ])("shouldOfferMembership(%j) → %s", (input, expected) => {
    expect(shouldOfferMembership(input)).toBe(expected);
  });

  it("a non-member booking routine maintenance hears Comfort Club once, after the booking", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    const args = bookingArgs(slot.id, { service_type: "maintenance", issue_summary: "Annual furnace tune-up" });
    const first = await callTool("book_appointment", args, { callId, callerNumber: "+17185550530" });
    expect(first.payload).toMatchObject({ ok: true, offer_membership: true });
    expect(first.payload.say).toContain(BUSINESS.facts.membershipPitch);
    expect(first.payload.say).toMatch(/only once/);

    // Same caller, same window, new call: already booked, so no second pitch.
    const again = await callTool("book_appointment", args, { callerNumber: "+17185550530" });
    expect(again.payload).toMatchObject({ ok: true, already_booked: true, offer_membership: false });
    expect(again.payload.say).not.toContain("Comfort Club");
  });

  it("an active member is never pitched", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      bookingArgs(slot.id, {
        customer_id: DANA,
        address_id: "00000000-0000-4000-8001-000000000001",
        address: undefined,
        first_name: "Dana",
        last_name: "Quillfeather",
        service_type: "maintenance",
      }),
    );
    expect(payload).toMatchObject({ ok: true, offer_membership: false });
    expect(payload.say).not.toContain("Comfort Club");
  });

  it("verified members get the benefits to mention when relevant; non-members don't", async () => {
    const dana = await callTool("lookup_customer", { street_address: "four twelve seventh avenue" }, { callerNumber: "+17185550101" });
    expect(dana.payload).toMatchObject({ verified: true, is_member: true, member_benefits: BUSINESS.facts.memberBenefits });
    expect(dana.payload.say).toContain("mention briefly that priority scheduling");

    const lena = await callTool("lookup_customer", { street_address: "1450 Ocean Avenue" }, { callerNumber: "+19175550104" });
    expect(lena.payload).toMatchObject({ verified: true, is_member: false, member_benefits: null });
    expect(lena.payload.say).not.toContain("active member");
  });
});

describe("existing appointments (lookup_customer)", () => {
  it("a verified caller gets the next appointment as day and window only; an unverified caller gets nothing", async () => {
    const phone = "+17185550540";
    const tuesday = await makeSlot({ capacity: 3, booked: 0, day: "tuesday" });
    const friday = await makeSlot({ capacity: 3, booked: 0, day: "friday" });
    for (const slot of [friday, tuesday]) {
      const b = await callTool("book_appointment", bookingArgs(slot.id, { address: { line1: "40 Next Appt St", city: "Brooklyn", zip: "11215" } }), { callerNumber: phone });
      expect(b.payload).toMatchObject({ ok: true });
    }

    const verified = await callTool("lookup_customer", { street_address: "forty next appt street" }, { callerNumber: phone });
    expect(verified.payload).toMatchObject({ verified: true });
    // The earliest one, labeled the way it's spoken; no address or ids.
    expect(verified.payload.next_appointment).toMatch(/^tomorrow, Tuesday, \w+ \d+, between \d/);
    expect(verified.payload.say).toMatch(/reschedule or cancel, don't change anything yourself/);

    const unverified = await callTool("lookup_customer", {}, { callerNumber: phone });
    expect(unverified.payload).toMatchObject({ verified: false, verification_required: true });
    expect(unverified.payload).not.toHaveProperty("next_appointment");

    // Once both windows have ended there's nothing upcoming.
    const later = await callTool(
      "lookup_customer",
      { street_address: "40 Next Appt St" },
      { callerNumber: phone, deps: { now: () => new Date(TEST_NOW.getTime() + 6 * 24 * 3_600_000) } },
    );
    expect(later.payload).toMatchObject({ verified: true, next_appointment: null });
    expect(later.payload.say).not.toMatch(/reschedule/);
  });
});

describe("language callbacks", () => {
  it("stores the language and asks for a bilingual confirmation", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool(
      "create_callback_request",
      { reason: "other", details: "Spanish speaker, no heat, wants a call back in Spanish", language: "Spanish" },
      { callId, callerNumber: "+17185550550" },
    );
    expect(payload).toMatchObject({ ok: true, status: "open" });
    expect(payload.say).toContain("then once in simple Spanish");
    const [row] = await testDb().select().from(callbackRequests).where(eq(callbackRequests.vapiCallId, callId));
    expect(row.context).toMatchObject({ language: "Spanish" });

    const item = callbackItem({ ...(row as unknown as BoardCallbackRow), triageUrgency: null, triageReasons: [], triageArgs: null }, TEST_NOW);
    expect(item.language).toBe("Spanish");
  });

  it("English (or no language) adds nothing", async () => {
    const { payload } = await callTool("create_callback_request", { reason: "human_requested", details: "Wants a person", language: "English" }, { callerNumber: "+17185550551" });
    expect(payload.say).not.toMatch(/simple/);
  });
});
