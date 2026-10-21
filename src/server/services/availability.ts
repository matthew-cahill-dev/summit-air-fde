// Shared by triage_issue, get_availability and book_appointment (alternatives).
import type { Repositories } from "@/server/repositories";
import type { Weekday } from "@/server/lib/time";
import {
  DEFAULT_SCHEDULING_CONFIG,
  earliestBookableStart,
  selectSlots,
  type PreferredWindow,
  type SlotSelection,
} from "@/server/scheduling/availability";

export type AvailabilityRequest = {
  county: string;
  urgency: "urgent" | "routine";
  isMember: boolean;
  preferredWindow?: PreferredWindow;
  preferredDay?: Weekday;
  after?: Date;
  /** Exclude this slot (e.g. the one that was just taken). */
  excludeSlotId?: string;
  now: Date;
  timeZone: string;
};

export async function findOfferableSlots(repos: Repositories, req: AvailabilityRequest): Promise<SlotSelection> {
  const config = DEFAULT_SCHEDULING_CONFIG;
  const rows = await repos.scheduling.findOpenSlots({
    county: req.county,
    from: earliestBookableStart(req.now, config),
    to: new Date(req.now.getTime() + config.routineHorizonDays * 24 * 3_600_000),
  });
  return selectSlots(
    rows.filter((r) => r.id !== req.excludeSlotId),
    {
      now: req.now,
      timeZone: req.timeZone,
      urgency: req.urgency,
      isMember: req.isMember,
      preferredWindow: req.preferredWindow,
      preferredDay: req.preferredDay,
      after: req.after,
    },
    config,
  );
}

/** Active membership for a known customer id; false for unknown/new callers. */
export async function isActiveMember(repos: Repositories, customerId: string | undefined): Promise<boolean> {
  if (!customerId) return false;
  const rows = await repos.customers.findCallerContextByCustomerId(customerId);
  return Boolean(rows?.memberships.some((m) => m.status === "active"));
}
