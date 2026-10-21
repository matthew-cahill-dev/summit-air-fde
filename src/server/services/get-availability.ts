import { z } from "zod";
import { BUSINESS, coverageOf } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { addDays, dayOfWeek, todayInZone, type CalendarDate } from "@/server/lib/time";
import { defineTool } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";
import { preferredWindowSchema, zipSchema } from "./triage-issue";

export const getAvailabilitySchema = z.object({
  zip: zipSchema,
  urgency: z.enum(["urgent", "routine"]),
  preferred_window: optionalArg(preferredWindowSchema),
  preferred_day: optionalArg(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])),
  preferred_date: optionalArg(z.iso.date()),
  after: optionalArg(z.iso.datetime({ offset: true })),
  customer_id: optionalArg(z.uuid()),
});

export type SchedulingNote = "weekdays_only" | "beyond_booking_horizon" | "date_passed";

const cmp = (a: CalendarDate, b: CalendarDate) => a.year - b.year || a.month - b.month || a.day - b.day;
const parseDate = (iso: string): CalendarDate => {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
};

/**
 * Why a requested day can't be offered, said honestly: weekday windows only, booking about two
 * weeks out (BUSINESS.scheduling.routineHorizonDays), or a date that has passed. Pure.
 */
export function schedulingNote(
  req: { preferredDay?: string; preferredDate?: string },
  today: CalendarDate,
  horizonDays = BUSINESS.scheduling.routineHorizonDays,
): SchedulingNote | null {
  if (req.preferredDate) {
    const d = parseDate(req.preferredDate);
    if (cmp(d, today) < 0) return "date_passed";
    if (cmp(d, addDays(today, horizonDays)) > 0) return "beyond_booking_horizon";
    const dow = dayOfWeek(d);
    if (dow === 0 || dow === 6) return "weekdays_only";
  }
  if (req.preferredDay === "saturday" || req.preferredDay === "sunday") return "weekdays_only";
  return null;
}

const NOTE_SAY: Record<SchedulingNote, string> = {
  weekdays_only: `We schedule ${BUSINESS.facts.appointmentHours} only. Say so plainly and offer these weekday windows instead. `,
  beyond_booking_horizon:
    "We book about two weeks out, so that date isn't open yet. Say so plainly, offer the earliest of these windows, or offer an office callback to schedule further out (create_callback_request, reason other, details 'schedule for' plus the date). ",
  date_passed: "That date has passed; you probably misheard it. Check the date with them, and meanwhile offer these. ",
};

export const getAvailabilityTool = defineTool({
  schema: getAvailabilitySchema,
  async handler(args, ctx) {
    const zipRow = await ctx.repos.serviceArea.findZip(args.zip);
    const cov = coverageOf(zipRow);
    if (zipRow && cov.coverage === "coverage_check") {
      return {
        ok: false,
        errorCode: "coverage_check",
        message: `${cov.borough} coverage isn't confirmed`,
        say: `Don't offer times. Say: "Let me have our office confirm whether we can cover that address." Next: call create_callback_request with reason other and details starting "coverage check: ${cov.borough}".`,
      };
    }
    if (!zipRow?.active) {
      return {
        ok: false,
        errorCode: "out_of_area",
        message: `ZIP ${args.zip} is outside the service area`,
        say: `Confirm the ZIP. If it's right, explain we only serve homes in ${BUSINESS.facts.serviceArea}. Next: if it was misheard, call get_availability again with the corrected ZIP; otherwise ask if there's anything else.`,
      };
    }
    const note = schedulingNote({ preferredDay: args.preferred_day, preferredDate: args.preferred_date }, todayInZone(ctx.settings.timeZone, ctx.now));
    const selection = await findOfferableSlots(ctx.repos, {
      county: zipRow.county,
      urgency: args.urgency,
      isMember: await isActiveMember(ctx.repos, args.customer_id),
      preferredWindow: args.preferred_window,
      // A day we can't offer isn't a filter: offer the earliest windows with the honest reason.
      preferredDay: note ? undefined : args.preferred_day,
      preferredDate: note || !args.preferred_date ? undefined : parseDate(args.preferred_date),
      after: args.after ? new Date(args.after) : undefined,
      now: ctx.now,
      timeZone: ctx.settings.timeZone,
    });
    if (selection.slots.length === 0) {
      return {
        ok: true,
        data: { offered_slots: [], county: zipRow.county, scheduling_note: note },
        say: "Nothing else is open in the next two weeks. Next: offer a callback from the office and, if they agree, call create_callback_request (reason other, details with the problem and their preferred times).",
      };
    }
    return {
      ok: true,
      data: {
        offered_slots: selection.slots,
        preference_matched: note ? false : selection.preferenceMatched,
        slots_within_target: selection.withinTarget,
        county: zipRow.county,
        scheduling_note: note,
      },
      say:
        (note ? NOTE_SAY[note] : "") +
        (selection.preferenceMatched || note
          ? ""
          : `Nothing matches that preference (we schedule ${BUSINESS.facts.appointmentHours}); say so plainly, don't guess why, and offer these instead. `) +
        "Next: offer these windows using the label wording; for later times, call again with after set to the last starts_at. Once they pick one, gather the technician essentials you still need, read back, get a yes and call book_appointment.",
    };
  },
});
