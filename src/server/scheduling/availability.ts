// Pure slot selection: which arrival windows a caller may be offered.
import { BUSINESS } from "@/config/business";
import { localInfo, spokenWindow, type CalendarDate, type Weekday } from "@/server/lib/time";

export type SlotCandidate = {
  id: string;
  county: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
};

export type PreferredWindow = "morning" | "afternoon" | "any";

export type SchedulingConfig = {
  urgentWindowHours: number;
  routineHorizonDays: number;
  bookingLeadTimeMinutes: number;
  memberReservedSeatsPerSlot: number;
  memberPriorityWindowHours: number;
  maxOfferedSlots: number;
  morningEndsHour: number;
};

export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = BUSINESS.scheduling;

export type OfferedSlot = { slot_id: string; starts_at: string; ends_at: string; label: string };

export type SlotSelection = {
  slots: OfferedSlot[];
  /** Urgent only: false when nothing was free inside the urgent window and later windows are offered. */
  withinTarget: boolean;
  /** False when the caller's preferred window/day had nothing and other times are offered instead. */
  preferenceMatched: boolean;
};

export type SelectOptions = {
  now: Date;
  timeZone: string;
  urgency: "urgent" | "routine";
  isMember: boolean;
  preferredWindow?: PreferredWindow;
  preferredDay?: Weekday;
  /** A specific local date. */
  preferredDate?: CalendarDate;
  /** Only windows starting strictly after this instant ("anything later?"). */
  after?: Date;
};

const HOUR = 3_600_000;

/** Seats this caller may take: the member-reserved seat is hidden from non-members inside the priority window. */
export function seatsAvailableFor(slot: SlotCandidate, isMember: boolean, now: Date, config: SchedulingConfig): number {
  const inPriorityWindow = slot.startsAt.getTime() < now.getTime() + config.memberPriorityWindowHours * HOUR;
  const reserved = !isMember && inPriorityWindow ? config.memberReservedSeatsPerSlot : 0;
  return slot.capacity - slot.booked - reserved;
}

/** Earliest instant a window may start to be offered or booked. */
export function earliestBookableStart(now: Date, config: SchedulingConfig): Date {
  return new Date(now.getTime() + config.bookingLeadTimeMinutes * 60_000);
}

/**
 * The rules for an atomic seat claim (BookingTx.claimSeat): lead time, and the member-held seat
 * inside the priority window. One definition for booking on a call and rescheduling in the console.
 */
export function seatClaimRules(now: Date, isMember: boolean, config: SchedulingConfig = DEFAULT_SCHEDULING_CONFIG) {
  return {
    isMember,
    earliestStart: earliestBookableStart(now, config),
    memberPriorityUntil: new Date(now.getTime() + config.memberPriorityWindowHours * 3_600_000),
    memberReservedSeats: config.memberReservedSeatsPerSlot,
  };
}

export function selectSlots(
  candidates: SlotCandidate[],
  opts: SelectOptions,
  config: SchedulingConfig = DEFAULT_SCHEDULING_CONFIG,
): SlotSelection {
  const earliest = Math.max(earliestBookableStart(opts.now, config).getTime(), (opts.after?.getTime() ?? 0) + 1);
  const routineHorizon = opts.now.getTime() + config.routineHorizonDays * 24 * HOUR;
  const urgentHorizon = opts.now.getTime() + config.urgentWindowHours * HOUR;

  const open = candidates
    .filter((s) => s.startsAt.getTime() >= earliest && s.startsAt.getTime() <= routineHorizon)
    .filter((s) => seatsAvailableFor(s, opts.isMember, opts.now, config) > 0)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const matchesPreference = (s: SlotCandidate) => {
    const info = localInfo(s.startsAt, opts.timeZone);
    if (opts.preferredDay && info.weekday !== opts.preferredDay) return false;
    const d = opts.preferredDate;
    if (d && (info.date.year !== d.year || info.date.month !== d.month || info.date.day !== d.day)) return false;
    if (opts.preferredWindow === "morning" && info.hour >= config.morningEndsHour) return false;
    if (opts.preferredWindow === "afternoon" && info.hour < config.morningEndsHour) return false;
    return true;
  };

  let pool = open;
  let withinTarget = true;
  if (opts.urgency === "urgent") {
    const urgent = open.filter((s) => s.startsAt.getTime() <= urgentHorizon);
    if (urgent.length) pool = urgent;
    else withinTarget = false;
  }

  const preferred = pool.filter(matchesPreference);
  const hasPreference = Boolean(opts.preferredDay || opts.preferredDate || (opts.preferredWindow && opts.preferredWindow !== "any"));
  const preferenceMatched = !hasPreference || preferred.length > 0;
  const chosen = (preferred.length ? preferred : pool).slice(0, config.maxOfferedSlots);

  return {
    slots: chosen.map((s) => ({
      slot_id: s.id,
      starts_at: s.startsAt.toISOString(),
      ends_at: s.endsAt.toISOString(),
      label: spokenWindow(s.startsAt, s.endsAt, opts.timeZone, opts.now),
    })),
    withinTarget: chosen.length > 0 && withinTarget,
    preferenceMatched,
  };
}
