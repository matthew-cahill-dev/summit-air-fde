import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { streetAddressMatches } from "@/server/lib/address-match";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { spokenWindow } from "@/server/lib/time";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { getCallerContext, restrictToAddresses, verifyCustomerByName, type CallerContext } from "./caller-context";
import { zipSchema } from "./triage-issue";

// Identity rule: nothing stored (name, address, membership, equipment, ids) is
// returned until the CALLER states a street address that matches one on file.
export const MAX_FAILED_VERIFICATIONS_PER_CALL = 3;

export const lookupCustomerSchema = z
  .object({
    phone: optionalArg(z.string().trim().min(1)),
    street_address: optionalArg(z.string().trim().min(3)),
    last_name: optionalArg(z.string().trim().min(1)),
    zip: optionalArg(zipSchema),
  })
  .superRefine((v, ctx) => {
    // ZIP is optional with last_name: it's derived from the matched address.
    if (v.last_name && !v.street_address) {
      ctx.addIssue({ code: "custom", path: ["street_address"], message: "required with last_name" });
    }
  });

type FoundContext = Extract<CallerContext, { found: true }>;

/** Pure: the agent-facing payload for a VERIFIED customer. Still no last name, email or access-note text. */
export function verifiedPayload(context: FoundContext): Record<string, unknown> {
  return {
    found: true,
    verified: true,
    matched_by: context.matchedBy,
    customer_id: context.customerId,
    first_name: context.firstName,
    is_member: context.isActiveMember,
    membership: context.membership ? { status: context.membership.status, plan: context.membership.planName } : null,
    member_benefits: context.isActiveMember ? BUSINESS.facts.memberBenefits : null,
    addresses: context.addresses.map((a) => ({
      address_id: a.addressId,
      line1: a.line1,
      unit: a.unit,
      zip: a.zip,
      access_notes_on_file: Boolean(a.accessNotes),
    })),
    equipment_summary: context.equipmentSummary,
  };
}

/**
 * The next step for anyone who isn't (or can't be) verified. No technician questions before triage,
 * and one question per turn: client session 1 (live call 01a165a4) stacked "house or apartment?"
 * with the vulnerability question twice and got neither answered.
 */
export const NEW_CALLER_NEXT =
  "Next: get the service address (the ZIP only if they haven't said it), confirm home or business only if it's unclear, ask once whether anyone at home is elderly, a baby, pregnant or has a medical condition, then call triage_issue. No technician questions yet. One question per turn, and wait for each answer: never ask house or apartment in the same turn as another question.";

/**
 * Requirement (c) without caller ID (or from another phone): ask, don't wait to be told. Smoke run
 * 50e283bc: a Comfort Club Plus member on chat (no caller ID) was booked as new because nobody asked.
 */
export const ASK_IF_CUSTOMER =
  "Next: unless they've already said, confirm once with a quick yes or no: \"Is this your first time calling Summit Air?\" If they've used Summit Air before or are a Comfort Club member, ask for their last name and the street, then call lookup_customer with last_name and street_address. If they talk past the question, don't ask it again.";

const VERIFIED_SAY =
  "Verified. You may greet them by first name and use these account details. ZIP, borough and home type are on file; don't ask for them. Ask for the unit only if one is on file and they didn't say it. " +
  "Next: if you don't know yet whether anyone at home is elderly, a baby, pregnant or has a medical condition, ask once; then call triage_issue immediately (customer_id, the ZIP from addresses, property_type residential). No technician questions yet.";
const MEMBER_SAY = ` They're an active member: when it's relevant (offering times, or if cost comes up), mention briefly that ${BUSINESS.facts.memberBenefits}. Don't list benefits otherwise.`;
const NEXT_APPOINTMENT_SAY =
  " If they ask when their technician is coming, give next_appointment (day and window only). To reschedule or cancel, don't change anything yourself: offer an office callback (create_callback_request, reason other, details with the appointment and what they want) and say the office will confirm.";

/** Verified result plus the next upcoming appointment (day and window only) and member hints. */
async function verifiedOutcome(context: FoundContext, ctx: ToolContext, extra: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const next = await ctx.repos.customers.findNextAppointment(context.customerId, ctx.now);
  return {
    ok: true,
    data: {
      ...verifiedPayload(context),
      ...extra,
      next_appointment: next ? spokenWindow(next.startsAt, next.endsAt, ctx.settings.timeZone, ctx.now) : null,
    },
    say: VERIFIED_SAY + (context.isActiveMember ? MEMBER_SAY : "") + (next ? NEXT_APPOINTMENT_SAY : ""),
  };
}

const UNVERIFIED: ToolOutcome = {
  ok: true,
  data: { found: false, verified: false, verification_failed: true },
  say: `Couldn't verify that. Don't hint at whether an account exists or what's on file. Next: ask them to repeat the street address once and call lookup_customer again; if it still doesn't match, continue as a new customer without comment. ${NEW_CALLER_NEXT}`,
};

const LOCKED: ToolOutcome = {
  ok: true,
  data: { found: false, verified: false, verification_locked: true },
  say: `Too many attempts. Stop trying to verify and don't mention it; continue as a new customer, collecting their details fresh. ${NEW_CALLER_NEXT}`,
};

async function tooManyAttempts(ctx: ToolContext): Promise<boolean> {
  if (!ctx.callId) return false;
  return (await ctx.repos.toolInvocations.countFailedVerifications(ctx.callId)) >= MAX_FAILED_VERIFICATIONS_PER_CALL;
}

export const lookupCustomerTool = defineTool({
  schema: lookupCustomerSchema,
  async handler(args, ctx): Promise<ToolOutcome> {
    // Name path: last name + caller-stated street (+ ZIP if they gave it).
    if (args.last_name) {
      if (await tooManyAttempts(ctx)) return LOCKED;
      const result = await verifyCustomerByName(
        { lastName: args.last_name, zip: args.zip, streetAddress: args.street_address! },
        ctx.repos.customers,
      );
      logEvent("customer_verification", { callId: ctx.callId, path: "name", status: result.status, zip_given: Boolean(args.zip) });
      if (result.status === "verified") return verifiedOutcome(result.context, ctx);
      if (result.status === "ambiguous") {
        return {
          ok: true,
          data: { found: false, verified: false, ambiguous: true, needs: result.needs },
          say:
            result.needs === "zip"
              ? "Couldn't verify from that alone. Next: ask for the ZIP code and call lookup_customer again with last_name, street_address and zip."
              : "Couldn't verify from that alone. Next: ask for the phone number on the account and call lookup_customer with phone and street_address.",
        };
      }
      return UNVERIFIED;
    }

    // Phone path: caller ID (or a stated account number), then the caller's street.
    const raw = args.phone ?? ctx.callerPhone;
    if (!raw) {
      // Not an error: a withheld number is normal, and the prompt treats ok:false as a backend failure.
      return {
        ok: true,
        data: { found: false, verified: false, caller_id_unavailable: true },
        say: `Caller ID isn't available. ${ASK_IF_CUSTOMER} Otherwise: ${NEW_CALLER_NEXT}`,
      };
    }
    const phoneE164 = normalizePhoneE164(raw);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Invalid: phone (not a valid phone number)",
        say: "That number didn't look right. Next: ask the caller to repeat it, including area code, and call lookup_customer again.",
        data: { invalid_fields: [{ field: "phone", problem: "not a valid phone number" }] },
      };
    }
    if (args.street_address && (await tooManyAttempts(ctx))) return LOCKED;

    const { context, dbMs } = await getCallerContext(phoneE164, ctx.repos.customers, ctx.settings.demoCallerMap);
    logEvent("caller_context", { callId: ctx.callId, found: context.found, db_ms: dbMs });
    if (!context.found) {
      if (args.street_address) return UNVERIFIED;
      return {
        ok: true,
        data: { found: false, verified: false },
        say: `No account for this number. ${ASK_IF_CUSTOMER} Otherwise treat them as new: ${NEW_CALLER_NEXT}`,
      };
    }
    if (!args.street_address) {
      // An account exists for this number, but the caller isn't verified yet: disclose nothing.
      return {
        ok: true,
        data: { found: true, verified: false, verification_required: true },
        say: "Don't use or mention any account details yet. Next: if they already said the street, call lookup_customer again right now with street_address exactly as they said it; otherwise ask \"What's the address where you need service?\" and then call it. Don't ask for borough, ZIP or home type.",
      };
    }
    const stated = args.street_address;
    const matched = context.addresses.filter((a) => streetAddressMatches(stated, a.line1));
    logEvent("customer_verification", { callId: ctx.callId, path: "phone", verified: matched.length > 0 });
    if (matched.length === 0) return UNVERIFIED;
    return verifiedOutcome(restrictToAddresses(context, new Set(matched.map((a) => a.addressId))), ctx, {
      phone_e164: context.phoneE164,
    });
  },
});
