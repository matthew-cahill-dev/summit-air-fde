// Appointment lifecycle from the operations console: Scheduled → Completed / No-show / Cancelled,
// and Reschedule. Seats move only through the booking transaction's atomic claimSeat / releaseSeat
// (the same code book_appointment uses), so capacity can never be exceeded and a cancelled seat is
// free at once. Rescheduling keeps history: a new row with rescheduled_from, the old one cancelled.
// Each change has an inverse, used by the console's 5-second undo.
import { logEvent } from "@/server/lib/log";
import { spokenWindow } from "@/server/lib/time";
import type { Repositories } from "@/server/repositories";
import { seatClaimRules } from "@/server/scheduling/availability";
import { findOfferableSlots } from "./availability";

export type LifecycleResult =
  | { ok: true; appointmentId: string; message: string }
  | { ok: false; error: string };

type Deps = { repos: Pick<Repositories, "scheduling" | "customers">; now: Date; timeZone?: string };

class Refused extends Error {}

type Tx = Parameters<Parameters<Repositories["scheduling"]["runBooking"]>[0]>[0];

async function inTx(deps: Deps, fn: (tx: Tx) => Promise<LifecycleResult>): Promise<LifecycleResult> {
  try {
    return await deps.repos.scheduling.runBooking(fn);
  } catch (err) {
    if (err instanceof Refused) return { ok: false as const, error: err.message };
    throw err;
  }
}

const member = async (deps: Deps, customerId: string) =>
  Boolean((await deps.repos.customers.findCallerContextByCustomerId(customerId))?.memberships.some((m) => m.status === "active"));

/** Completed or No-show (with an optional note). Only from Scheduled. */
export function closeAppointment(id: string, outcome: "completed" | "no_show", note: string | null, by: string | null, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const a = await tx.lockAppointment(id);
    if (!a) throw new Refused("That appointment no longer exists.");
    if (a.status !== "confirmed" || a.completion) throw new Refused("It's no longer scheduled.");
    await tx.setAppointmentLifecycle(id, { completion: outcome, completedAt: deps.now, completionNote: note, statusBy: by });
    logEvent("appointment_closed", { id, outcome });
    return { ok: true as const, appointmentId: id, message: outcome === "completed" ? "Marked completed" : "Marked no-show" };
  });
}

/** Undo of Completed / No-show: back to Scheduled. */
export function reopenAppointment(id: string, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const a = await tx.lockAppointment(id);
    if (!a || a.status !== "confirmed" || !a.completion) throw new Refused("Nothing to undo.");
    await tx.setAppointmentLifecycle(id, { completion: null, completedAt: null, completionNote: null });
    return { ok: true as const, appointmentId: id, message: "Back to scheduled" };
  });
}

/** Cancel: the seat is released in the same transaction. */
export function cancelAppointment(id: string, by: string | null, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const a = await tx.lockAppointment(id);
    if (!a) throw new Refused("That appointment no longer exists.");
    if (a.status !== "confirmed" || a.completion) throw new Refused("It's no longer scheduled.");
    await tx.setAppointmentLifecycle(id, { status: "cancelled", cancelledAt: deps.now, statusBy: by });
    await tx.releaseSeat(a.slotId);
    logEvent("appointment_cancelled", { id });
    return { ok: true as const, appointmentId: id, message: "Cancelled; the window is free again" };
  });
}

/** Undo of Cancel: re-claims the seat atomically (fails if the window filled up meanwhile). */
export function uncancelAppointment(id: string, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const a = await tx.lockAppointment(id);
    if (!a || a.status !== "cancelled") throw new Refused("Nothing to undo.");
    const claimed = await tx.claimSeat(a.slotId, { ...seatClaimRules(deps.now, await member(deps, a.customerId)), earliestStart: new Date(0) });
    if (!claimed) throw new Refused("That window has filled up since; reschedule instead.");
    await tx.setAppointmentLifecycle(id, { status: "confirmed", cancelledAt: null });
    return { ok: true as const, appointmentId: id, message: "Restored" };
  });
}

/**
 * Move to another window: claim the new seat (atomic, same rules as a booking), insert the new
 * appointment with rescheduled_from, cancel the old one and release its seat. One transaction.
 */
export function rescheduleAppointment(id: string, newSlotId: string, by: string | null, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const a = await tx.lockAppointment(id);
    if (!a) throw new Refused("That appointment no longer exists.");
    if (a.status !== "confirmed" || a.completion) throw new Refused("Only a scheduled appointment can be rescheduled.");
    if (a.slotId === newSlotId) throw new Refused("That's the current window.");
    const slot = await tx.getSlot(newSlotId);
    const current = await tx.getSlot(a.slotId);
    if (!slot || !current) throw new Refused("That window no longer exists.");
    if (slot.county !== current.county) throw new Refused("That window is for a different borough.");
    const claimed = await tx.claimSeat(newSlotId, seatClaimRules(deps.now, await member(deps, a.customerId)));
    if (!claimed) throw new Refused("That window was just taken. Pick another.");
    const fields = {
      slotId: newSlotId,
      customerId: a.customerId,
      addressId: a.addressId,
      serviceType: a.serviceType,
      urgency: a.urgency,
      issueSummary: a.issueSummary,
      symptoms: a.symptoms,
      intake: a.intake,
      technicianNotes: a.technicianNotes,
      vapiCallId: a.vapiCallId,
      rescheduledFrom: a.id,
      isDemoSeed: a.isDemoSeed,
    };
    // Unique per customer and window: a cancelled booking there is brought back instead.
    const existing = await tx.findAppointment(a.customerId, newSlotId);
    let newId: string;
    if (existing) {
      await tx.replaceAppointment(existing.id, fields);
      await tx.setAppointmentLifecycle(existing.id, { completion: null, completedAt: null, cancelledAt: null, statusBy: by });
      newId = existing.id;
    } else {
      newId = (await tx.insertAppointment(fields)).id;
      await tx.setAppointmentLifecycle(newId, { statusBy: by });
    }
    await tx.setAppointmentLifecycle(a.id, { status: "cancelled", cancelledAt: deps.now, statusBy: by });
    await tx.releaseSeat(a.slotId);
    logEvent("appointment_rescheduled", { from: a.id, to: newId });
    return {
      ok: true as const,
      appointmentId: newId,
      message: `Rescheduled to ${spokenWindow(slot.startsAt, slot.endsAt, deps.timeZone ?? "America/New_York", deps.now)}`,
    };
  });
}

/** Undo of Reschedule: the new appointment goes away (seat released) and the old one comes back (seat re-claimed). */
export function undoReschedule(newId: string, deps: Deps): Promise<LifecycleResult> {
  return inTx(deps, async (tx) => {
    const n = await tx.lockAppointment(newId);
    if (!n || !n.rescheduledFrom) throw new Refused("Nothing to undo.");
    const old = await tx.lockAppointment(n.rescheduledFrom);
    if (!old || old.status !== "cancelled") throw new Refused("Nothing to undo.");
    const claimed = await tx.claimSeat(old.slotId, { ...seatClaimRules(deps.now, await member(deps, old.customerId)), earliestStart: new Date(0) });
    if (!claimed) throw new Refused("The original window has filled up since.");
    await tx.deleteAppointment(newId);
    await tx.releaseSeat(n.slotId);
    await tx.setAppointmentLifecycle(old.id, { status: "confirmed", cancelledAt: null });
    return { ok: true as const, appointmentId: old.id, message: "Back to the original window" };
  });
}

export type WindowOption = { slotId: string; label: string; startsAt: string };

/**
 * Real availability for the reschedule picker: the same selection get_availability uses (same
 * borough, urgency and member rules), paged with `after` to show more than one turn's worth.
 */
export async function rescheduleOptions(
  a: { slotId: string; county: string; urgency: "urgent" | "routine" | "emergency" | "safety_stop"; isMember: boolean },
  deps: { repos: Repositories; now: Date; timeZone: string },
  pages = 3,
): Promise<WindowOption[]> {
  const out: WindowOption[] = [];
  let after: Date | undefined;
  for (let i = 0; i < pages; i++) {
    const sel = await findOfferableSlots(deps.repos, {
      county: a.county,
      urgency: a.urgency === "urgent" ? "urgent" : "routine",
      isMember: a.isMember,
      after,
      excludeSlotId: a.slotId,
      now: deps.now,
      timeZone: deps.timeZone,
    });
    if (sel.slots.length === 0) break;
    for (const s of sel.slots) if (!out.some((o) => o.slotId === s.slot_id)) out.push({ slotId: s.slot_id, label: s.label, startsAt: s.starts_at });
    after = new Date(sel.slots.at(-1)!.starts_at);
  }
  return out;
}
