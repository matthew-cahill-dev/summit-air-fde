import { z } from "zod";
import { streetAddressMatches } from "@/server/lib/address-match";
import { logEvent } from "@/server/lib/log";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { getCallerContext, restrictToAddresses, verifyCustomerByName, type CallerContext } from "./caller-context";
import { zipSchema } from "./triage-issue";

// Identity rule: nothing stored (name, address, membership, equipment, ids) is
// returned until the CALLER states a street address that matches one on file.
export const MAX_FAILED_VERIFICATIONS_PER_CALL = 3;

export const lookupCustomerSchema = z
  .object({
    phone: z.string().trim().min(1).optional(),
    street_address: z.string().trim().min(3).optional(),
    last_name: z.string().trim().min(1).optional(),
    zip: zipSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.last_name && !v.zip) ctx.addIssue({ code: "custom", path: ["zip"], message: "required with last_name" });
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

const VERIFIED_SAY =
  "Identity verified. You may now greet them by first name and use these account details. Ask for the unit if one is on file and they didn't say it.";

const UNVERIFIED: ToolOutcome = {
  ok: true,
  data: { found: false, verified: false, verification_failed: true },
  say: "Couldn't verify that. Don't hint at whether an account exists or what's on file. Ask them to repeat the street address once; otherwise continue as a new customer.",
};

const LOCKED: ToolOutcome = {
  ok: true,
  data: { found: false, verified: false, verification_locked: true },
  say: "Too many attempts. Stop trying to verify and continue as a new customer, collecting their details fresh.",
};

async function tooManyAttempts(ctx: ToolContext): Promise<boolean> {
  if (!ctx.callId) return false;
  return (await ctx.repos.toolInvocations.countFailedVerifications(ctx.callId)) >= MAX_FAILED_VERIFICATIONS_PER_CALL;
}

export const lookupCustomerTool = defineTool({
  schema: lookupCustomerSchema,
  async handler(args, ctx): Promise<ToolOutcome> {
    // Name path: last name + ZIP + caller-stated street.
    if (args.last_name) {
      if (await tooManyAttempts(ctx)) return LOCKED;
      const result = await verifyCustomerByName(
        { lastName: args.last_name, zip: args.zip!, streetAddress: args.street_address! },
        ctx.repos.customers,
      );
      logEvent("customer_verification", { callId: ctx.callId, path: "name", status: result.status });
      if (result.status === "verified") return { ok: true, data: verifiedPayload(result.context), say: VERIFIED_SAY };
      if (result.status === "ambiguous") {
        return {
          ok: true,
          data: { found: false, verified: false, ambiguous: true },
          say: "Couldn't verify from that alone. Ask for the phone number on the account and look up with phone and street_address.",
        };
      }
      return UNVERIFIED;
    }

    // Phone path: caller ID (or a stated account number), then the caller's street.
    const raw = args.phone ?? ctx.callerPhone;
    if (!raw) {
      return {
        ok: false,
        errorCode: "missing_phone",
        message: "No phone number provided and caller ID is unavailable.",
        say: "Ask for the phone number on their account, or their last name, ZIP code and street address.",
      };
    }
    const phoneE164 = normalizePhoneE164(raw);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Invalid: phone (not a valid phone number)",
        say: "That number didn't look right. Ask the caller to repeat it, including area code.",
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
        say: "No account for this number. Ask if the account might be under another phone number, or their last name, ZIP code and street address. Otherwise treat them as a new customer.",
      };
    }
    if (!args.street_address) {
      // An account exists for this number, but the caller isn't verified yet: disclose nothing.
      return {
        ok: true,
        data: { found: true, verified: false, verification_required: true },
        say: "Don't use or mention any account details yet. Ask: what's the street address for the service? Then call lookup_customer again with street_address exactly as they said it.",
      };
    }
    const stated = args.street_address;
    const matched = context.addresses.filter((a) => streetAddressMatches(stated, a.line1));
    logEvent("customer_verification", { callId: ctx.callId, path: "phone", verified: matched.length > 0 });
    if (matched.length === 0) return UNVERIFIED;
    return {
      ok: true,
      data: { ...verifiedPayload(restrictToAddresses(context, new Set(matched.map((a) => a.addressId)))), phone_e164: context.phoneE164 },
      say: VERIFIED_SAY,
    };
  },
});
