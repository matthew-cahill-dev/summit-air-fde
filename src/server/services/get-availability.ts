import { z } from "zod";
import { BUSINESS, coverageOf } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { defineTool } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";
import { preferredWindowSchema, zipSchema } from "./triage-issue";

export const getAvailabilitySchema = z.object({
  zip: zipSchema,
  urgency: z.enum(["urgent", "routine"]),
  preferred_window: optionalArg(preferredWindowSchema),
  preferred_day: optionalArg(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])),
  after: optionalArg(z.iso.datetime({ offset: true })),
  customer_id: optionalArg(z.uuid()),
});

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
        say: `Don't offer times. Say: "Let me have our office confirm whether we can cover that address." Then call create_callback_request with reason other and details starting "coverage check: ${cov.borough}".`,
      };
    }
    if (!zipRow?.active) {
      return {
        ok: false,
        errorCode: "out_of_area",
        message: `ZIP ${args.zip} is outside the service area`,
        say: `Confirm the ZIP. If it's right, explain we only serve ${BUSINESS.facts.serviceArea}.`,
      };
    }
    const selection = await findOfferableSlots(ctx.repos, {
      county: zipRow.county,
      urgency: args.urgency,
      isMember: await isActiveMember(ctx.repos, args.customer_id),
      preferredWindow: args.preferred_window,
      preferredDay: args.preferred_day,
      after: args.after ? new Date(args.after) : undefined,
      now: ctx.now,
      timeZone: ctx.settings.timeZone,
    });
    if (selection.slots.length === 0) {
      return {
        ok: true,
        data: { offered_slots: [], county: zipRow.county },
        say: "Nothing else is open in the next two weeks. Offer a callback from the office with create_callback_request.",
      };
    }
    return {
      ok: true,
      data: {
        offered_slots: selection.slots,
        preference_matched: selection.preferenceMatched,
        slots_within_target: selection.withinTarget,
        county: zipRow.county,
      },
      say:
        (selection.preferenceMatched
          ? ""
          : `Nothing matches that preference (we schedule ${BUSINESS.facts.appointmentHours}); say so and offer these instead. `) +
        "Offer these windows using the label wording. To see later times, call again with after set to the last starts_at.",
    };
  },
});
