import { randomInt, randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appointments, appointmentSlots, customers, serviceAddresses } from "@/server/db/schema";
import type { Repositories } from "@/server/repositories";
import { callTool, testDb, testRepos } from "./helpers";

const HOUR = 3_600_000;

/** A dedicated slot so tests don't depend on (or disturb) seeded availability. */
async function makeSlot(opts: { county?: string; hoursFromNow?: number; capacity: number; booked: number }) {
  // Random second offset keeps (county, starts_at) unique across tests and runs.
  const startsAt = new Date(Date.now() + (opts.hoursFromNow ?? 72) * HOUR + randomInt(1, 3_000_000));
  const [row] = await testDb()
    .insert(appointmentSlots)
    .values({
      county: opts.county ?? "Kings",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * HOUR),
      capacity: opts.capacity,
      booked: opts.booked,
    })
    .returning();
  return row;
}

async function slotBooked(id: string) {
  const [row] = await testDb().select({ booked: appointmentSlots.booked }).from(appointmentSlots).where(eq(appointmentSlots.id, id));
  return row.booked;
}


function newCallerArgs(slotId: string, phone: string, over: Record<string, unknown> = {}) {
  return {
    slot_id: slotId,
    caller_confirmed: true,
    first_name: "Avery",
    last_name: "Testerly",
    phone,
    address: { line1: "77 Demo Pl", unit: "4R", city: "Brooklyn", zip: "11215" },
    service_type: "repair",
    urgency: "routine",
    issue_summary: "Radiators cold upstairs",
    symptoms: ["upstairs radiators cold", "boiler running"],
    equipment: "Gas boiler, about 10 years old",
    access_notes: "Buzzer 4R; dog in apartment",
    vulnerable_occupants: [],
    ...over,
  };
}

describe("book_appointment", () => {
  it("two concurrent bookings for the last seat: exactly one succeeds", async () => {
    const slot = await makeSlot({ capacity: 1, booked: 0 });
    const [a, b] = await Promise.all([
      callTool("book_appointment", newCallerArgs(slot.id, "+17185550301")),
      callTool("book_appointment", newCallerArgs(slot.id, "+17185550302", { first_name: "Blake" })),
    ]);
    const outcomes = [a, b].map((r) => r.payload);
    expect(outcomes.filter((p) => p.ok === true)).toHaveLength(1);
    const loser = outcomes.find((p) => p.ok === false)!;
    expect(loser).toMatchObject({ error_code: "slot_taken", reason: "slot_taken" });
    expect(await slotBooked(slot.id)).toBe(1);
    const [{ n }] = await testDb().select({ n: count() }).from(appointments).where(eq(appointments.slotId, slot.id));
    expect(n).toBe(1);
  });

  it("idempotent: a replay returns the identical result and books once", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    const args = newCallerArgs(slot.id, "+17185550303");
    const first = await callTool("book_appointment", args, { callId });
    const second = await callTool("book_appointment", args, { callId });
    expect(first.payload).toMatchObject({ ok: true, booked: true, already_booked: false });
    expect(second.entry.result).toBe(first.entry.result);

    // A different call for the same customer + window is also safe.
    const third = await callTool("book_appointment", args);
    expect(third.payload).toMatchObject({ ok: true, already_booked: true, appointment_id: first.payload.appointment_id });
    expect(await slotBooked(slot.id)).toBe(1);
  });

  it("slot_taken returns ok:false with up to 3 alternatives in the same county", async () => {
    const full = await makeSlot({ capacity: 2, booked: 2, county: "Kings" });
    const { entry, payload } = await callTool("book_appointment", newCallerArgs(full.id, "+17185550304"));
    expect(entry.result).toBeUndefined();
    expect(payload).toMatchObject({ ok: false, reason: "slot_taken" });
    const alts = payload.alternatives as Array<{ slot_id: string; label: string }>;
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.length).toBeLessThanOrEqual(3);
    expect(alts.map((a) => a.slot_id)).not.toContain(full.id);
    expect(payload.say).toMatch(/alternatives/);
  });

  it("creates a new customer and address, with dispatch-ready technician notes", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const phone = "+17185550305";
    const { payload } = await callTool("book_appointment", newCallerArgs(slot.id, phone, { phone: undefined }), { callerNumber: phone });
    expect(payload).toMatchObject({ ok: true, booked: true, new_customer: true, confirmation_code: expect.stringMatching(/^SA-[0-9A-F]{6}$/) });

    const [customer] = await testDb().select().from(customers).where(eq(customers.phoneE164, phone));
    expect(customer).toMatchObject({ firstName: "Avery", lastName: "Testerly", isDemoSeed: false });
    const [address] = await testDb().select().from(serviceAddresses).where(eq(serviceAddresses.customerId, customer.id));
    expect(address).toMatchObject({ line1: "77 Demo Pl", unit: "4R", zip: "11215", county: "Kings", accessNotes: "Buzzer 4R; dog in apartment" });

    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.technicianNotes).toMatch(/^ROUTINE repair for Avery Testerly \(non-member\) at 77 Demo Pl, Apt 4R, Brooklyn, NY 11215\. Arrival window: \w+day, \w+ \d+, between /);
    expect(appt.technicianNotes).toContain("Symptoms: upstairs radiators cold; boiler running.");
    expect(appt.technicianNotes).toContain("Access: Buzzer 4R; dog in apartment.");
    expect(appt.technicianNotes).toContain("Contact: (718) 555-0305.");
    expect(appt.intake).toMatchObject({ caller_confirmed: true, equipment: "Gas boiler, about 10 years old" });

    // Booking again with the address spelled differently reuses the same address row.
    const slot2 = await makeSlot({ capacity: 3, booked: 0 });
    await callTool("book_appointment", newCallerArgs(slot2.id, phone, { address: { line1: "77 DEMO PLACE", unit: "Apt 4R", zip: "11215" } }));
    const addrs = await testDb().select().from(serviceAddresses).where(eq(serviceAddresses.customerId, customer.id));
    expect(addrs).toHaveLength(1);
  });

  it("existing customer via customer_id + address_id; members may take the held last seat inside 48h", async () => {
    // capacity 2, booked 1, starts in 24h → the last seat is held for members.
    const slot = await makeSlot({ capacity: 2, booked: 1, hoursFromNow: 24 });
    const nonMember = await callTool("book_appointment", newCallerArgs(slot.id, "+17185550306"));
    expect(nonMember.payload).toMatchObject({ ok: false, reason: "slot_taken" });

    const dana = await callTool("book_appointment", {
      ...newCallerArgs(slot.id, "+17185550101"),
      customer_id: "00000000-0000-4000-8000-000000000001",
      address_id: "00000000-0000-4000-8001-000000000001",
      address: undefined,
      first_name: "Dana",
      last_name: "Quillfeather",
    });
    expect(dana.payload).toMatchObject({ ok: true, booked: true, new_customer: false, address: { line1: "412 Seventh Ave" } });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, dana.payload.appointment_id as string));
    expect(appt.technicianNotes).toContain("Dana Quillfeather (active member)");
  });

  it("rejects a window in a different borough than the address", async () => {
    const queensSlot = await makeSlot({ capacity: 3, booked: 0, county: "Queens" });
    const { payload } = await callTool("book_appointment", newCallerArgs(queensSlot.id, "+17185550307"));
    expect(payload).toMatchObject({ ok: false, error_code: "slot_wrong_area" });
    expect(await slotBooked(queensSlot.id)).toBe(0);
    // The rolled-back transaction didn't leave a customer behind.
    expect(await testDb().select().from(customers).where(eq(customers.phoneE164, "+17185550307"))).toHaveLength(0);
  });

  it("requires caller_confirmed: true", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool("book_appointment", newCallerArgs(slot.id, "+17185550308", { caller_confirmed: false }));
    expect(payload).toMatchObject({ ok: false, error_code: "invalid_arguments" });
    expect(payload.invalid_fields).toEqual([{ field: "caller_confirmed", problem: expect.stringContaining("caller's yes") }]);
  });

  it("an injected repository failure returns an error string and never ok:true", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const broken = (): Repositories => {
      const repos = testRepos();
      return {
        ...repos,
        scheduling: {
          ...repos.scheduling,
          runBooking: async () => {
            throw new Error("connection terminated unexpectedly");
          },
        },
      };
    };
    const { entry, payload } = await callTool("book_appointment", newCallerArgs(slot.id, "+17185550309"), { deps: { repos: broken } });
    expect(entry.result).toBeUndefined();
    expect(typeof entry.error).toBe("string");
    expect(payload).toMatchObject({ ok: false, error_code: "internal_error" });
    expect(JSON.stringify(payload)).not.toContain("connection terminated"); // internals stay in logs
    expect(await slotBooked(slot.id)).toBe(0);
  });

  it("rejects an out-of-area address before touching the slot", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool("book_appointment", newCallerArgs(slot.id, "+17185550310", { address: { line1: "600 W 110th St", zip: "10025" } }));
    expect(payload).toMatchObject({ ok: false, error_code: "out_of_area" });
  });
});

describe("get_availability", () => {
  it("pages later with `after` and flags unmatched preferences (no Saturday windows)", async () => {
    const first = await callTool("get_availability", { zip: "11372", urgency: "routine" });
    const slots = first.payload.offered_slots as Array<{ slot_id: string; starts_at: string }>;
    expect(first.payload).toMatchObject({ ok: true, county: "Queens" });
    expect(slots.length).toBeGreaterThan(0);

    const later = await callTool("get_availability", { zip: "11372", urgency: "routine", after: slots.at(-1)!.starts_at });
    for (const s of later.payload.offered_slots as Array<{ starts_at: string }>) {
      expect(new Date(s.starts_at).getTime()).toBeGreaterThan(new Date(slots.at(-1)!.starts_at).getTime());
    }

    const saturday = await callTool("get_availability", { zip: "11372", urgency: "routine", preferred_day: "saturday" });
    expect(saturday.payload).toMatchObject({ ok: true, preference_matched: false });
  });

  it("morning preference only returns windows starting before noon", async () => {
    const { payload } = await callTool("get_availability", { zip: "10314", urgency: "routine", preferred_window: "morning" });
    for (const s of payload.offered_slots as Array<{ starts_at: string }>) {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(s.starts_at)));
      expect(hour).toBeLessThan(12);
    }
  });

  it("out of area is an error naming the reason", async () => {
    expect((await callTool("get_availability", { zip: "10025", urgency: "routine" })).payload).toMatchObject({ ok: false, error_code: "out_of_area" });
  });
});

