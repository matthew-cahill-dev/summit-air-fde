import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { appointments, appointmentSlots, customers, memberships, serviceAddresses } from "@/server/db/schema";
import type { BookingAddress, BookingTx, SchedulingRepository, SlotRow } from "./types";

const slotColumns = {
  id: appointmentSlots.id,
  county: appointmentSlots.county,
  startsAt: appointmentSlots.startsAt,
  endsAt: appointmentSlots.endsAt,
  capacity: appointmentSlots.capacity,
  booked: appointmentSlots.booked,
};

const customerColumns = {
  id: customers.id,
  firstName: customers.firstName,
  lastName: customers.lastName,
  phoneE164: customers.phoneE164,
};

const addressColumns = {
  id: serviceAddresses.id,
  line1: serviceAddresses.line1,
  unit: serviceAddresses.unit,
  city: serviceAddresses.city,
  zip: serviceAddresses.zip,
  county: serviceAddresses.county,
  propertyType: serviceAddresses.propertyType,
  accessNotes: serviceAddresses.accessNotes,
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function bookingTx(tx: Tx): BookingTx {
  return {
    async getSlot(slotId) {
      const [row] = await tx.select(slotColumns).from(appointmentSlots).where(eq(appointmentSlots.id, slotId)).limit(1);
      return (row as SlotRow | undefined) ?? null;
    },

    async findCustomerById(customerId) {
      const [row] = await tx.select(customerColumns).from(customers).where(eq(customers.id, customerId)).limit(1);
      return row ?? null;
    },

    async findCustomerByPhone(phoneE164) {
      const [row] = await tx.select(customerColumns).from(customers).where(eq(customers.phoneE164, phoneE164)).limit(1);
      return row ?? null;
    },

    async insertCustomer(input) {
      const [inserted] = await tx
        .insert(customers)
        .values({ ...input, isDemoSeed: false })
        .onConflictDoNothing({ target: customers.phoneE164 })
        .returning(customerColumns);
      if (inserted) return inserted;
      const [existing] = await tx.select(customerColumns).from(customers).where(eq(customers.phoneE164, input.phoneE164));
      return existing;
    },

    async hasActiveMembership(customerId) {
      const [row] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.customerId, customerId), eq(memberships.status, "active")))
        .limit(1);
      return Boolean(row);
    },

    async findAddresses(customerId) {
      return tx.select(addressColumns).from(serviceAddresses).where(eq(serviceAddresses.customerId, customerId));
    },

    async insertAddress(input) {
      const [row] = await tx
        .insert(serviceAddresses)
        .values({ ...input, state: "NY", isDemoSeed: false })
        .returning(addressColumns);
      return row as BookingAddress;
    },

    async updateAccessNotes(addressId, accessNotes) {
      await tx.update(serviceAddresses).set({ accessNotes }).where(eq(serviceAddresses.id, addressId));
    },

    async findAppointment(customerId, slotId) {
      const [row] = await tx
        .select({ id: appointments.id, status: appointments.status, intake: appointments.intake })
        .from(appointments)
        .where(and(eq(appointments.customerId, customerId), eq(appointments.slotId, slotId)))
        .limit(1);
      return row ? { ...row, intake: (row.intake ?? null) as Record<string, unknown> | null } : null;
    },

    async updateAppointmentDetails(id, input) {
      await tx.update(appointments).set({ intake: input.intake, technicianNotes: input.technicianNotes }).where(eq(appointments.id, id));
    },

    async lockCall(vapiCallId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${vapiCallId}`}))`);
    },

    async findCallAppointment(vapiCallId) {
      const [row] = await tx
        .select({ id: appointments.id, slotId: appointments.slotId, intake: appointments.intake })
        .from(appointments)
        .where(and(eq(appointments.vapiCallId, vapiCallId), eq(appointments.status, "confirmed")))
        .orderBy(asc(appointments.createdAt))
        .limit(1);
      return row ? { ...row, intake: (row.intake ?? null) as Record<string, unknown> | null } : null;
    },

    async releaseSeat(slotId) {
      await tx
        .update(appointmentSlots)
        .set({ booked: sql`${appointmentSlots.booked} - 1` })
        .where(and(eq(appointmentSlots.id, slotId), sql`${appointmentSlots.booked} > 0`));
    },

    async replaceAppointment(id, input) {
      await tx.update(appointments).set({ ...input, status: "confirmed" }).where(eq(appointments.id, id));
    },

    async cancelAppointment(id) {
      await tx.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, id));
    },

    async lockAppointment(id) {
      const [row] = await tx.select().from(appointments).where(eq(appointments.id, id)).limit(1).for("update");
      if (!row) return null;
      return {
        id: row.id,
        slotId: row.slotId,
        customerId: row.customerId,
        addressId: row.addressId,
        serviceType: row.serviceType,
        urgency: row.urgency,
        issueSummary: row.issueSummary ?? "",
        symptoms: Array.isArray(row.symptoms) ? (row.symptoms as string[]) : [],
        intake: (row.intake ?? {}) as Record<string, unknown>,
        technicianNotes: row.technicianNotes ?? "",
        vapiCallId: row.vapiCallId,
        status: row.status,
        completion: row.completion,
        isDemoSeed: row.isDemoSeed,
        rescheduledFrom: row.rescheduledFrom,
      };
    },

    async setAppointmentLifecycle(id, patch) {
      if (Object.keys(patch).length === 0) return;
      await tx.update(appointments).set(patch).where(eq(appointments.id, id));
    },

    async deleteAppointment(id) {
      await tx.delete(appointments).where(eq(appointments.id, id));
    },

    async claimSeat(slotId, rules) {
      // Single statement: concurrent claims serialize on the row lock and each
      // re-checks the WHERE clause, so capacity can never be exceeded.
      const reserved = sql`case when ${rules.isMember} or ${appointmentSlots.startsAt} >= ${rules.memberPriorityUntil} then 0 else ${rules.memberReservedSeats} end`;
      const rows = await tx
        .update(appointmentSlots)
        .set({ booked: sql`${appointmentSlots.booked} + 1` })
        .where(
          and(
            eq(appointmentSlots.id, slotId),
            gte(appointmentSlots.startsAt, rules.earliestStart),
            sql`${appointmentSlots.booked} < ${appointmentSlots.capacity} - ${reserved}`,
          ),
        )
        .returning({ id: appointmentSlots.id });
      return rows.length === 1;
    },

    async insertAppointment(input) {
      const [row] = await tx
        .insert(appointments)
        .values({ ...input, status: "confirmed" })
        .returning({ id: appointments.id });
      return row;
    },
  };
}

export function createSchedulingRepository(db: Db): SchedulingRepository {
  return {
    async findOpenSlots({ county, from, to }) {
      return db
        .select(slotColumns)
        .from(appointmentSlots)
        .where(
          and(
            eq(appointmentSlots.county, county),
            gte(appointmentSlots.startsAt, from),
            lte(appointmentSlots.startsAt, to),
            lt(appointmentSlots.booked, appointmentSlots.capacity),
          ),
        )
        .orderBy(asc(appointmentSlots.startsAt))
        .limit(300);
    },

    runBooking(fn) {
      return db.transaction((tx) => fn(bookingTx(tx)));
    },

    async hasConfirmedAppointmentForCall(vapiCallId) {
      const [row] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.vapiCallId, vapiCallId), eq(appointments.status, "confirmed")))
        .limit(1);
      return Boolean(row);
    },

    async findConfirmedAppointment(customerId, slotId) {
      const [row] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(eq(appointments.customerId, customerId), eq(appointments.slotId, slotId), eq(appointments.status, "confirmed")),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
