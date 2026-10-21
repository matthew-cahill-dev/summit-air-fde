import { randomInt } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appointmentSlots, customers, memberships, serviceAddresses } from "@/server/db/schema";
import { countNonSeedData, resetNonSeedData } from "@/server/db/reset-test-data";
import { SEED_CUSTOMERS } from "@/server/db/seed-data";
import { callTool, slotFactory, TEST_NOW, testDb, testSettings } from "./helpers";

const REAL_PHONE = "+12025550142"; // stands in for a tester's real cell
const TOMAS = "00000000-0000-4000-8000-000000000005";

const newSlot = slotFactory(3);
const makeSlot = (booked: number) => newSlot({ county: "Queens", capacity: 4, booked });
const at = { now: () => TEST_NOW };

const slotBooked = async (id: string) =>
  (await testDb().select({ booked: appointmentSlots.booked }).from(appointmentSlots).where(eq(appointmentSlots.id, id)))[0].booked;

function bookingArgs(slotId: string, over: Record<string, unknown> = {}) {
  return {
    slot_id: slotId,
    caller_confirmed: true,
    first_name: "Avery",
    last_name: "Testerly",
    address: { line1: "31-10 Demo Blvd", city: "Astoria", zip: "11105" },
    service_type: "repair",
    urgency: "routine",
    issue_summary: "No heat upstairs",
    ...over,
  };
}

describe("DEMO_CALLER_PHONES precedence over a phone-matched non-seed customer", () => {
  it("lookup and booking resolve to the demo persona, never the stray customer", async () => {
    // A failed verification + booking on an earlier call created a non-seed customer with the real cell.
    const earlierSlot = await makeSlot(0);
    const stray = await callTool("book_appointment", bookingArgs(earlierSlot.id), { callerNumber: REAL_PHONE, deps: at });
    expect(stray.payload).toMatchObject({ ok: true, new_customer: true });
    const strayId = stray.payload.customer_id as string;
    expect(strayId).not.toBe(TOMAS);

    // Now the phone is aliased to a persona.
    const deps = { settings: testSettings({ demoCallerMap: new Map([[REAL_PHONE, TOMAS]]) }) };
    const unverified = await callTool("lookup_customer", {}, { callerNumber: REAL_PHONE, deps });
    expect(unverified.payload).toMatchObject({ found: true, verified: false, verification_required: true });
    const verified = await callTool("lookup_customer", { street_address: "21 45 30 first street" }, { callerNumber: REAL_PHONE, deps });
    expect(verified.payload).toMatchObject({ verified: true, matched_by: "demo_alias", customer_id: TOMAS, first_name: "Tomas" });
    expect(JSON.stringify(verified.payload)).not.toContain("Avery");

    // Booking without customer_id (e.g. after a failed verification) also lands on the persona.
    const slot = await makeSlot(0);
    const booked = await callTool(
      "book_appointment",
      bookingArgs(slot.id, { first_name: "Tomas", last_name: "Wrenfield", address: { line1: "21-45 31st St", unit: "1R", city: "Astoria", zip: "11105" } }),
      { callerNumber: REAL_PHONE, deps: { ...deps, ...at } },
    );
    expect(booked.payload).toMatchObject({ ok: true, customer_id: TOMAS, new_customer: false });
    const [{ n }] = await testDb().select({ n: count() }).from(customers).where(eq(customers.phoneE164, REAL_PHONE));
    expect(n).toBe(1); // only the stray from before; no new customer
  });
});

describe("db:reset-test (resetNonSeedData)", () => {
  it("deletes call-created data, restores slot seats, and keeps every seed row", async () => {
    const db = testDb();
    const seedCounts = async () => ({
      customers: (await db.select({ n: count() }).from(customers).where(eq(customers.isDemoSeed, true)))[0].n,
      addresses: (await db.select({ n: count() }).from(serviceAddresses).where(eq(serviceAddresses.isDemoSeed, true)))[0].n,
      memberships: (await db.select({ n: count() }).from(memberships).where(eq(memberships.isDemoSeed, true)))[0].n,
      equipment: Number((await db.execute(sql`select count(*) as n from equipment`)).rows[0].n),
    });
    const before = await seedCounts();
    expect(before.customers).toBe(SEED_CUSTOMERS.length);

    // A new caller's booking, a new address on a SEED customer, a callback, an end-of-call row.
    const slot = await makeSlot(2);
    expect((await callTool("book_appointment", bookingArgs(slot.id), { callerNumber: "+17185550188", deps: at })).payload).toMatchObject({ ok: true });
    const seedNewAddress = await callTool(
      "book_appointment",
      bookingArgs(slot.id, { customer_id: TOMAS, first_name: "Tomas", last_name: "Wrenfield", address: { line1: "9 Second Home Rd", city: "Astoria", zip: "11105" } }),
      { deps: at },
    );
    expect(seedNewAddress.payload).toMatchObject({ ok: true, customer_id: TOMAS });
    expect(await slotBooked(slot.id)).toBe(4);
    await callTool("create_callback_request", { reason: "human_requested", details: "Wants to talk to a person", phone: "+17185550188" });
    await db.execute(sql`insert into calls (vapi_call_id, caller_phone) values (${`reset-${randomInt(1e9)}`}, '+17185550188')`);

    const pending = await countNonSeedData(db);
    expect(pending.appointments).toBeGreaterThanOrEqual(2);
    expect(pending.customers).toBeGreaterThanOrEqual(1);
    expect(pending.addresses).toBeGreaterThanOrEqual(2);
    expect(pending.callbackRequests).toBeGreaterThanOrEqual(1);
    expect(pending.calls).toBeGreaterThanOrEqual(1);
    expect(pending.toolInvocations).toBeGreaterThanOrEqual(3);

    const deleted = await resetNonSeedData(db);
    expect(deleted).toMatchObject({
      appointments: pending.appointments,
      customers: pending.customers,
      addresses: pending.addresses,
      callbackRequests: pending.callbackRequests,
      calls: pending.calls,
      toolInvocations: pending.toolInvocations,
    });

    // Seats given back: the slot is at its pre-booking count again.
    expect(await slotBooked(slot.id)).toBe(2);
    // Nothing non-seed is left; every seed row survived.
    expect(Object.values(await countNonSeedData(db)).every((v) => v === 0)).toBe(true);
    expect(await seedCounts()).toEqual(before);
    const [tomas] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, TOMAS));
    expect(tomas).toBeDefined();
  });
});
