import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { todayInZone } from "@/server/lib/time";
import { ISSUE_TYPES, triageRules, VULNERABLE_OCCUPANTS, type TriageDecision } from "@/server/triage/rules";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";

export const zipSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, "must be a 5-digit ZIP code")
  .transform((v) => v.slice(0, 5));

export const preferredWindowSchema = z.enum(["morning", "afternoon", "any"]);

export const triageIssueSchema = z.object({
  issue_type: z.enum(ISSUE_TYPES),
  gas_smell: z.boolean(),
  co_alarm: z.boolean(),
  burning_smell_or_smoke: z.boolean(),
  vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
  indoor_temp_f: optionalArg(z.number().min(-20).max(130)),
  property_type: z.enum(["residential", "commercial"]),
  multi_unit_central_system: optionalArg(z.boolean()),
  zip: zipSchema,
  customer_id: optionalArg(z.uuid()),
  preferred_window: optionalArg(preferredWindowSchema),
});

type TriageArgs = z.infer<typeof triageIssueSchema>;

const SAFETY_SAY =
  "Give the gas and carbon monoxide safety instructions now: leave the home with everyone, don't touch switches or flames, don't use a phone inside, and call 911 from outside. Do not book an appointment. Say clearly that Summit Air has NOT contacted 911, the fire department or the gas utility; the caller must call 911 themselves.";

export const OFFICE_REVIEW_CALLBACK = { reason: "other", details: "multi-unit/central system, office to review" } as const;

async function recordSafetyStop(args: TriageArgs, decision: TriageDecision, ctx: ToolContext): Promise<boolean> {
  try {
    if (ctx.callId && (await ctx.repos.dispatch.findOpenForCall(ctx.callId, "safety_stop"))) return true;
    await ctx.repos.dispatch.create({
      customerId: args.customer_id ?? null,
      callerPhone: ctx.callerPhone,
      callerName: null,
      address: { zip: args.zip },
      urgency: "safety_stop",
      reasons: decision.reasons,
      intake: { source: "triage_issue", flags: args },
      vapiCallId: ctx.callId,
    });
    return true;
  } catch (err) {
    logEvent("safety_stop_record_failed", { callId: ctx.callId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export const triageIssueTool = defineTool({
  schema: triageIssueSchema,
  async handler(args, ctx): Promise<ToolOutcome> {
    const zipRow = await ctx.repos.serviceArea.findZip(args.zip);
    const area = { zip: args.zip, inArea: Boolean(zipRow?.active), county: zipRow?.active ? zipRow.county : null };
    const decision = triageRules(
      {
        issueType: args.issue_type,
        gasSmell: args.gas_smell,
        coAlarm: args.co_alarm,
        burningSmellOrSmoke: args.burning_smell_or_smoke,
        vulnerableOccupants: args.vulnerable_occupants,
        indoorTempF: args.indoor_temp_f,
        propertyType: args.property_type,
        centralMultiUnit: args.multi_unit_central_system ?? false,
      },
      area,
      todayInZone(ctx.settings.timeZone, ctx.now),
    );
    const base = {
      urgency: decision.urgency,
      reasons: decision.reasons,
      serviceable: decision.serviceable,
      ...(decision.notServiceableReason ? { not_serviceable_reason: decision.notServiceableReason } : {}),
      in_area: area.inArea,
      county: area.county,
    };

    if (decision.nextAction === "safety_instructions") {
      // Safety guidance never depends on the database; the follow-up record is best effort.
      const recorded = await recordSafetyStop(args, decision, ctx);
      return {
        ok: true,
        data: { ...base, next_action: "safety_instructions", office_followup_recorded: recorded },
        say:
          SAFETY_SAY +
          (recorded
            ? " You may say the Summit Air office has a note to follow up once they're safe."
            : " Do not say the office was notified."),
      };
    }

    if (decision.nextAction === "explain_and_close") {
      const commercial = decision.notServiceableReason === "residential_only";
      return {
        ok: true,
        data: {
          ...base,
          next_action: "explain_and_close",
          ...(commercial ? { commercial_referrals: BUSINESS.commercialReferrals } : {}),
        },
        say: commercial
          ? BUSINESS.commercialReferrals
            ? "Kindly explain Summit Air only services homes, then offer an office callback with referrals to commercial HVAC companies (create_callback_request, reason other, details 'commercial referral')."
            : "Kindly explain Summit Air only services homes, so they'll want a commercial HVAC company. Give no other reason (no licensing, insurance or policy talk), don't offer a referral or a callback, then thank them and end the call."
          : `Confirm the ZIP once. If it's right, explain we only serve ${BUSINESS.facts.serviceArea}. If anyone's health is at risk, they should call 911.`,
      };
    }

    if (decision.nextAction === "office_review") {
      return {
        ok: true,
        data: { ...base, next_action: "office_review", callback: OFFICE_REVIEW_CALLBACK },
        say:
          "Don't book. Explain kindly that building-wide systems serving several units are reviewed by the office before anyone is scheduled. " +
          "Get their name and best callback number, then call create_callback_request with reason other and details starting 'multi-unit/central system, office to review', plus the address and problem.",
      };
    }

    if (decision.nextAction === "priority_dispatch") {
      const offerTransfer = ctx.settings.transferAvailable;
      return {
        ok: true,
        data: { ...base, next_action: "priority_dispatch", offer_transfer: offerTransfer },
        say:
          "This qualifies for priority dispatch. Collect name, callback number and full address, then call create_priority_dispatch with these reasons." +
          (offerTransfer ? " Also offer to connect them to the on-call team now." : ""),
      };
    }

    // Bookable: one tool call gets the caller straight to offered times.
    const urgency = decision.nextAction === "book_earliest" ? "urgent" : "routine";
    const selection = await findOfferableSlots(ctx.repos, {
      county: area.county!,
      urgency,
      isMember: await isActiveMember(ctx.repos, args.customer_id),
      preferredWindow: args.preferred_window,
      now: ctx.now,
      timeZone: ctx.settings.timeZone,
    });

    if (selection.slots.length === 0) {
      return {
        ok: true,
        data: { ...base, next_action: "create_callback", offered_slots: [] },
        say: "There are no open arrival windows right now. Apologize and offer a callback from the office to schedule; use create_callback_request.",
      };
    }
    return {
      ok: true,
      data: {
        ...base,
        next_action: decision.nextAction,
        offered_slots: selection.slots,
        slots_within_target: selection.withinTarget,
        preference_matched: selection.preferenceMatched,
      },
      say:
        (urgency === "urgent" && !selection.withinTarget
          ? "Nothing is open in the next 48 hours; apologize and offer these later windows. "
          : "") +
        (selection.preferenceMatched ? "" : "Nothing matched their preferred time; say so and offer these instead. ") +
        "Offer up to these windows using the label wording, one or two at a time.",
    };
  },
});
