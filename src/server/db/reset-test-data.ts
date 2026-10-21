// Removes everything live/test calls created, keeping seed data:
// calls, tool_invocations, appointments (giving their seats back to the slots),
// dispatch_requests, callback_requests, and customers/addresses/memberships
// that aren't seed rows (is_demo_seed = false). Equipment on deleted addresses
// goes with them (ON DELETE CASCADE). Seed customers, addresses, memberships,
// equipment, ZIPs, slots and the demo call activity (also is_demo_seed) survive.
// Keep this file free of path aliases: it is also compiled for the CLI script.
import { sql } from "drizzle-orm";
import type { Db } from "./client";

export type ResetCounts = {
  calls: number;
  toolInvocations: number;
  appointments: number;
  slotsRestored: number;
  dispatchRequests: number;
  callbackRequests: number;
  customers: number;
  addresses: number;
  memberships: number;
};

const count = async (db: Pick<Db, "execute">, query: ReturnType<typeof sql>) =>
  Number(((await db.execute(query)).rows[0] as { n: string | number }).n);

/** What a reset would delete. Read-only. */
export async function countNonSeedData(db: Db): Promise<ResetCounts> {
  return {
    calls: await count(db, sql`select count(*) as n from calls where is_demo_seed = false`),
    toolInvocations: await count(db, sql`select count(*) as n from tool_invocations where is_demo_seed = false`),
    appointments: await count(db, sql`select count(*) as n from appointments where is_demo_seed = false`),
    slotsRestored: await count(db, sql`select count(distinct slot_id) as n from appointments where status = 'confirmed' and is_demo_seed = false`),
    dispatchRequests: await count(db, sql`select count(*) as n from dispatch_requests where is_demo_seed = false`),
    callbackRequests: await count(db, sql`select count(*) as n from callback_requests where is_demo_seed = false`),
    customers: await count(db, sql`select count(*) as n from customers where is_demo_seed = false`),
    addresses: await count(db, sql`select count(*) as n from service_addresses where is_demo_seed = false`),
    memberships: await count(db, sql`select count(*) as n from memberships where is_demo_seed = false`),
  };
}

/** Delete all non-seed data in one transaction. Returns the rows affected per table. */
export async function resetNonSeedData(db: Db): Promise<ResetCounts> {
  return db.transaction(async (tx) => {
    const n = async (query: ReturnType<typeof sql>) => (await tx.execute(query)).rowCount ?? 0;
    // Give each confirmed appointment's seat back before the appointment goes. Seed slots
    // start with synthetic "booked" counts that have no appointment rows; those are kept.
    const slotsRestored = await n(sql`
      update appointment_slots s
         set booked = greatest(0, s.booked - c.taken)
        from (select slot_id, count(*)::int as taken from appointments where status = 'confirmed' and is_demo_seed = false group by slot_id) c
       where s.id = c.slot_id`);
    const appointments = await n(sql`delete from appointments where is_demo_seed = false`);
    const dispatchRequests = await n(sql`delete from dispatch_requests where is_demo_seed = false`);
    const callbackRequests = await n(sql`delete from callback_requests where is_demo_seed = false`);
    const toolInvocations = await n(sql`delete from tool_invocations where is_demo_seed = false`);
    const calls = await n(sql`delete from calls where is_demo_seed = false`);
    // Addresses/memberships a call added to a SEED customer, then whole non-seed customers
    // (their remaining addresses and memberships cascade and are counted with them).
    const addresses =
      (await n(sql`delete from service_addresses where is_demo_seed = false and customer_id in (select id from customers where is_demo_seed = true)`)) +
      (await count(tx, sql`select count(*) as n from service_addresses where is_demo_seed = false`));
    const memberships =
      (await n(sql`delete from memberships where is_demo_seed = false and customer_id in (select id from customers where is_demo_seed = true)`)) +
      (await count(tx, sql`select count(*) as n from memberships where is_demo_seed = false`));
    const customers = await n(sql`delete from customers where is_demo_seed = false`);
    return {
      calls,
      toolInvocations,
      appointments,
      slotsRestored,
      dispatchRequests,
      callbackRequests,
      customers,
      addresses,
      memberships,
    };
  });
}
