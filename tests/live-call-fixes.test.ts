// Fixes for issues found in live production calls (Oct 21, 2026): verified callers asked for
// data on file, duplicate callbacks, commercial declines, property type visibility.
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BUSINESS } from "@/config/business";
import { callbackItem } from "@/server/console/board";
import { summarizeCall } from "@/server/console/outcome";
import { appointments, appointmentSlots, callbackRequests, customers, dispatchRequests } from "@/server/db/schema";
import type { BoardCallbackRow, CallActivityRow } from "@/server/repositories";
import { createConsoleRepository } from "@/server/repositories/console";
import { mergeDetails, mergeReason } from "@/server/services/callback-request";
import { propertyKind } from "@/server/triage/property";
import { businessFactsText } from "@/vapi-sync/render";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";

const makeSlot = slotFactory(5);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const PRIYA = "00000000-0000-4000-8000-000000000002";
const PRIYA_ADDRESS = "00000000-0000-4000-8001-000000000002";
const triageArgs = (over: Record<string, unknown> = {}) => ({
  issue_type: "no_cooling",
  gas_smell: false,
  co_alarm: false,
  burning_smell_or_smoke: false,
  property_type: "residential",
  zip: "11372",
  ...over,
});

describe("verified callers are never asked for data on the account", () => {
  it("book_appointment with customer_id + address_id needs no name, phone or address (live: 'Invalid: last_name')", async () => {
    const slot = await makeSlot({ county: "Queens", capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", triageArgs({ customer_id: PRIYA }), { callId });
    // Exactly what the model sent live, minus the bug: blank name fields.
    const { payload } = await callTool(
      "book_appointment",
      {
        slot_id: slot.id,
        caller_confirmed: true,
        customer_id: PRIYA,
        address_id: PRIYA_ADDRESS,
        first_name: "",
        last_name: "",
        service_type: "repair",
        urgency: "routine",
        issue_summary: "Central AC not cooling",
      },
      { callId },
    );
    expect(payload).toMatchObject({ ok: true, booked: true, new_customer: false, customer_id: PRIYA, address: { line1: "37-12 82nd St" } });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.technicianNotes).toMatch(/^Property: Residential\. ROUTINE repair for Priya Marlowe-Venn \(active member\) at 37-12 82nd St, Jackson Heights, NY 11372\./);
    expect(appt.technicianNotes).toContain("Contact: (347) 555-0102.");
  });

  it("an existing customer matched by phone books without names too", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      {
        slot_id: slot.id,
        caller_confirmed: true,
        address: { line1: "412 Seventh Ave", zip: "11215" },
        service_type: "maintenance",
        urgency: "routine",
        issue_summary: "Boiler tune-up",
      },
      { callerNumber: "+17185550101" },
    );
    expect(payload).toMatchObject({ ok: true, new_customer: false });
  });

  it("a NEW customer still needs a name, named per field, and nothing is written", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const phone = "+17185550601";
    const { payload } = await callTool(
      "book_appointment",
      {
        slot_id: slot.id,
        caller_confirmed: true,
        first_name: "Jo",
        address: { line1: "9 New Pl", zip: "11215" },
        service_type: "repair",
        urgency: "routine",
        issue_summary: "No heat upstairs",
      },
      { callerNumber: phone },
    );
    expect(payload).toMatchObject({
      ok: false,
      error_code: "invalid_arguments",
      message: "Missing: last_name",
      invalid_fields: [{ field: "last_name", problem: "required for a new customer" }],
    });
    expect(payload.say).toMatch(/ask for their last name/);
    expect(await testDb().select().from(customers).where(eq(customers.phoneE164, phone))).toHaveLength(0);
    const [{ booked }] = await testDb().select({ booked: appointmentSlots.booked }).from(appointmentSlots).where(eq(appointmentSlots.id, slot.id));
    expect(booked).toBe(0);
  });

  it("create_priority_dispatch for a verified caller takes name, phone and address from the account", async () => {
    const callId = `call-${randomUUID()}`;
    // No caller ID (e.g. withheld): the account phone is used.
    const { payload } = await callTool(
      "create_priority_dispatch",
      {
        customer_id: PRIYA,
        address_id: PRIYA_ADDRESS,
        first_name: "",
        issue_type: "no_heat",
        issue_summary: "No heat, elderly mother at home",
        vulnerable_occupants: ["elderly"],
        reasons: ["No heat during heat season (Oct 1 to May 31) with vulnerable occupants: elderly"],
      },
      { callId },
    );
    expect(payload).toMatchObject({ ok: true, status: "open", callback_phone: "+13475550102" });
    const [row] = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(row).toMatchObject({ callerName: "Priya Marlowe-Venn", callerPhone: "+13475550102", customerId: PRIYA });
    expect(row.address).toMatchObject({ line1: "37-12 82nd St", zip: "11372", access_notes: "Side door by the driveway." });
  });

  it("create_priority_dispatch rejects an address_id that isn't on the account, and address_id without customer_id", async () => {
    const wrong = await callTool("create_priority_dispatch", {
      customer_id: PRIYA,
      address_id: "00000000-0000-4000-8001-000000000001", // Dana's
      issue_type: "no_heat",
      issue_summary: "No heat",
      reasons: ["x"],
    });
    expect(wrong.payload).toMatchObject({ ok: false, invalid_fields: [{ field: "address_id", problem: "not on this account" }] });

    const orphan = await callTool("create_priority_dispatch", { address_id: PRIYA_ADDRESS, first_name: "A", issue_type: "no_heat", issue_summary: "No heat", reasons: ["x"] });
    expect(orphan.payload).toMatchObject({ ok: false, error_code: "invalid_arguments", invalid_fields: [{ field: "customer_id" }] });

    const nothing = await callTool("create_priority_dispatch", { first_name: "A", issue_type: "no_heat", issue_summary: "No heat", reasons: ["x"] }, { callerNumber: "+17185550602" });
    expect(nothing.payload).toMatchObject({ ok: false, invalid_fields: [{ field: "address" }] });
  });
});

describe("property type is visible (call header, board cards, technician notes)", () => {
  it.each([
    [{ property_type: "residential" }, "residential"],
    [{ property_type: "commercial" }, "commercial"],
    [{ property_type: "residential", multi_unit_central_system: true }, "multi_unit"],
    [{}, null],
    [null, null],
  ] as const)("propertyKind(%j) → %s", (args, kind) => {
    expect(propertyKind(args)).toBe(kind);
  });

  it("a multi-unit emergency's dispatch notes open with the property", async () => {
    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", triageArgs({ issue_type: "no_heat", indoor_temp_f: 50, multi_unit_central_system: true }), { callId });
    await callTool(
      "create_priority_dispatch",
      { first_name: "Jordan", address: { line1: "410 Ocean Pkwy", zip: "11218" }, issue_type: "no_heat", issue_summary: "Building boiler down", reasons: ["x"] },
      { callId, callerNumber: "+13475550603" },
    );
    const [row] = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(row.intake).toMatchObject({ property_kind: "multi_unit" });
    expect((row.intake as { technician_notes: string }).technician_notes).toMatch(/^Property: Multi-unit building \(central system\)\./);

    // The board card shows it.
    const board = await createConsoleRepository(testDb()).board({ includeSeed: false });
    const card = board.dispatches.find((d) => d.vapiCallId === callId)!;
    expect(card.intake).toMatchObject({ property_kind: "multi_unit" });
  });

  it("calls list and callback cards show the property from the call's triage", async () => {
    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", triageArgs({ property_type: "commercial", zip: "11201" }), { callId });
    await callTool("create_callback_request", { reason: "out_of_area", details: "Thinks we misheard", preferred_callback_time: "after 5 PM" }, { callId, callerNumber: "+17185550604" });

    const repo = createConsoleRepository(testDb());
    const card = (await repo.board({ includeSeed: false })).callbacks.find((c) => c.vapiCallId === callId)!;
    expect(callbackItem(card, TEST_NOW)).toMatchObject({ property: "Commercial", preferredTime: "after 5 PM" });

    const call = (await repo.call(callId)) as CallActivityRow;
    expect(summarizeCall(call, await repo.callRecords([callId]), TEST_NOW).property).toBe("Commercial");
  });

  it("an untriaged callback shows no property", () => {
    const row: BoardCallbackRow = {
      id: "x",
      reason: "human_requested",
      context: { details: "Wants a person" },
      callerName: null,
      callerPhone: null,
      createdAt: TEST_NOW,
      vapiCallId: null,
      isDemoSeed: false,
      triageUrgency: null,
      triageReasons: [],
      triageArgs: null,
    };
    expect(callbackItem(row, TEST_NOW)).toMatchObject({ property: null, preferredTime: null });
  });
});

describe("callbacks: one per call", () => {
  const rowsFor = (callId: string) => testDb().select().from(callbackRequests).where(eq(callbackRequests.vapiCallId, callId));

  it("a second request on the same call updates the first and returns the same id (live: a preferred time made a second row)", async () => {
    const callId = `call-${randomUUID()}`;
    const first = await callTool("create_callback_request", { reason: "other", details: "Wants to reschedule Thursday's visit" }, { callId, callerNumber: "+17185550177" });
    const second = await callTool(
      "create_callback_request",
      { reason: "other", details: "Prefers mornings", preferred_callback_time: "tomorrow morning", phone: "718 555 0178" },
      { callId, callerNumber: "+17185550177" },
    );
    expect(first.payload).toMatchObject({ ok: true, updated: false });
    expect(second.payload).toMatchObject({ ok: true, updated: true, callback_id: first.payload.callback_id, callback_phone: "+17185550178" });
    expect(second.payload.say).toMatch(/updated \(still one request\)/);

    const rows = await rowsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "other", callerPhone: "+17185550178" });
    expect(rows[0].context).toMatchObject({
      details: "Wants to reschedule Thursday's visit Update: Prefers mornings",
      preferred_callback_time: "tomorrow morning",
    });
  });

  it("concurrent requests on one call still make one row", async () => {
    const callId = `call-${randomUUID()}`;
    await Promise.all(
      ["Needs a callback", "Needs a callback about heat", "Needs a callback, prefers evenings"].map((details) =>
        callTool("create_callback_request", { reason: "human_requested", details }, { callId, callerNumber: "+17185550605" }),
      ),
    );
    expect(await rowsFor(callId)).toHaveLength(1);
  });

  it("different calls get their own callbacks; a done callback doesn't absorb a new one", async () => {
    const a = `call-${randomUUID()}`;
    const b = `call-${randomUUID()}`;
    await callTool("create_callback_request", { reason: "human_requested", details: "Call A" }, { callId: a, callerNumber: "+17185550606" });
    await callTool("create_callback_request", { reason: "human_requested", details: "Call B" }, { callId: b, callerNumber: "+17185550606" });
    expect(await rowsFor(a)).toHaveLength(1);
    expect(await rowsFor(b)).toHaveLength(1);

    await testDb().update(callbackRequests).set({ status: "done" }).where(eq(callbackRequests.vapiCallId, a));
    await callTool("create_callback_request", { reason: "human_requested", details: "Call A again" }, { callId: a, callerNumber: "+17185550606" });
    const [{ n }] = await testDb().select({ n: count() }).from(callbackRequests).where(eq(callbackRequests.vapiCallId, a));
    expect(n).toBe(2);
  });

  it("merge rules keep every detail and the most specific reason", () => {
    expect(mergeDetails(undefined, "New")).toBe("New");
    expect(mergeDetails("No heat", "No heat, prefers mornings")).toBe("No heat, prefers mornings");
    expect(mergeDetails("No heat, prefers mornings", "No heat")).toBe("No heat, prefers mornings");
    expect(mergeDetails("No heat", "Prefers mornings")).toBe("No heat Update: Prefers mornings");
    expect(mergeReason("other", "human_requested")).toBe("human_requested");
    expect(mergeReason("backend_failure", "other")).toBe("backend_failure");
    expect(mergeReason(null, "other")).toBe("other");
  });
});

describe("commercial callers: decline with business facts only", () => {
  it("triage tells the model not to invent reasons or offer referrals when commercialReferrals is false", async () => {
    expect(BUSINESS.commercialReferrals).toBe(false);
    const { payload } = await callTool("triage_issue", triageArgs({ property_type: "commercial", zip: "11201" }));
    expect(payload).toMatchObject({ ok: true, next_action: "explain_and_close", not_serviceable_reason: "residential_only", commercial_referrals: false });
    expect(payload.say).toContain("only services homes");
    expect(payload.say).toContain("commercial HVAC company");
    expect(payload.say).toMatch(/no licensing, insurance or policy talk/);
    expect(payload.say).toMatch(/don't offer a referral or a callback/);
  });

  it("the business facts say plainly that we don't refer", () => {
    expect(businessFactsText()).toContain("Commercial callers: we don't refer them to other companies.");
  });
});
