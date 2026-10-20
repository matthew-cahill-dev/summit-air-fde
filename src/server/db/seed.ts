// Idempotent demo seed. Safe to re-run: customers/addresses/memberships/equipment
// are upserted by fixed ID, ZIPs by primary key, and slots by (county, starts_at)
// with DO NOTHING so existing bookings are preserved.
// Keep this file free of path aliases: it is also compiled for the seed script.
import { sql } from "drizzle-orm";
import { BUSINESS, SERVICE_AREA_ZIPS, type County } from "../../config/business";
import { nextBusinessDays, todayInZone, zonedTimeToUtc } from "../lib/time";
import type { Db } from "./client";
import {
  appointmentSlots,
  customers,
  equipment,
  memberships,
  serviceAddresses,
  serviceAreaZips,
} from "./schema";
import { SEED_CUSTOMERS, SLOT_WINDOWS } from "./seed-data";

export type SeedSummary = {
  customers: number;
  addresses: number;
  memberships: number;
  equipment: number;
  zips: number;
  slotsInserted: number;
};

export async function seed(db: Db, opts: { timeZone: string; now?: Date }): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    const zipRows = (Object.entries(SERVICE_AREA_ZIPS) as Array<[County, readonly string[]]>).flatMap(
      ([county, zips]) => zips.map((zip) => ({ zip, county, active: true })),
    );
    await tx
      .insert(serviceAreaZips)
      .values(zipRows)
      .onConflictDoUpdate({
        target: serviceAreaZips.zip,
        set: { county: sql`excluded.county`, active: sql`excluded.active` },
      });

    let addressCount = 0;
    let membershipCount = 0;
    let equipmentCount = 0;

    for (const c of SEED_CUSTOMERS) {
      await tx
        .insert(customers)
        .values({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          phoneE164: c.phoneE164,
          email: c.email,
          isDemoSeed: true,
        })
        .onConflictDoUpdate({
          target: customers.id,
          set: {
            firstName: c.firstName,
            lastName: c.lastName,
            phoneE164: c.phoneE164,
            email: c.email,
            isDemoSeed: true,
          },
        });

      if (c.membership) {
        const m = { ...c.membership, customerId: c.id, isDemoSeed: true };
        await tx.insert(memberships).values(m).onConflictDoUpdate({ target: memberships.id, set: m });
        membershipCount++;
      }

      for (const a of c.addresses) {
        const { equipment: equip, ...addr } = a;
        const row = { ...addr, customerId: c.id, state: "NY", isDemoSeed: true };
        await tx.insert(serviceAddresses).values(row).onConflictDoUpdate({ target: serviceAddresses.id, set: row });
        addressCount++;
        for (const e of equip) {
          const erow = { ...e, addressId: a.id };
          await tx.insert(equipment).values(erow).onConflictDoUpdate({ target: equipment.id, set: erow });
          equipmentCount++;
        }
      }
    }

    // Slots for the next 10 business days per county. Capacity and fullness are
    // deterministic per (day, county, window) so re-runs on the same day match.
    const days = nextBusinessDays(todayInZone(opts.timeZone, opts.now), 10);
    const capacities = [2, 3, 4, 1, 3];
    const slotRows: Array<typeof appointmentSlots.$inferInsert> = [];
    days.forEach((day, dayIdx) => {
      BUSINESS.serviceCounties.forEach((county, countyIdx) => {
        SLOT_WINDOWS.forEach((w, wIdx) => {
          const n = dayIdx * 7 + countyIdx * 3 + wIdx;
          const capacity = capacities[n % capacities.length];
          // Roughly one in four slots is full; others partly booked.
          const booked = n % 4 === 0 ? capacity : n % capacity;
          slotRows.push({
            county,
            startsAt: zonedTimeToUtc(day, w.startHour, 0, opts.timeZone),
            endsAt: zonedTimeToUtc(day, w.endHour, 0, opts.timeZone),
            capacity,
            booked,
          });
        });
      });
    });
    const inserted = await tx
      .insert(appointmentSlots)
      .values(slotRows)
      .onConflictDoNothing({ target: [appointmentSlots.county, appointmentSlots.startsAt] })
      .returning({ id: appointmentSlots.id });

    return {
      customers: SEED_CUSTOMERS.length,
      addresses: addressCount,
      memberships: membershipCount,
      equipment: equipmentCount,
      zips: zipRows.length,
      slotsInserted: inserted.length,
    };
  });
}
