import { z } from "zod";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { logEvent } from "@/server/lib/log";
import { defineTool, type ToolOutcome } from "@/server/vapi/types";
import { getCallerContext, type CallerContext } from "./caller-context";

export const lookupCustomerSchema = z.object({
  phone: z.string().trim().min(1).optional(),
});

/** Pure: the agent-facing payload. Only first name, membership, line1/unit/zip and equipment. */
export function toLookupResult(context: CallerContext): ToolOutcome {
  if (!context.found) {
    return {
      ok: true,
      data: { found: false, phone_e164: context.phoneE164 },
      say: "No account found for this number. Ask if they have another number on file; otherwise treat them as a new customer.",
    };
  }
  const membership = context.membership
    ? { status: context.membership.status, plan: context.membership.planName }
    : null;
  return {
    ok: true,
    data: {
      found: true,
      phone_e164: context.phoneE164,
      first_name: context.firstName,
      is_member: context.isActiveMember,
      membership,
      addresses: context.addresses.map((a) => ({ line1: a.line1, unit: a.unit, zip: a.zip })),
      equipment_summary: context.equipmentSummary,
    },
    say:
      `Greet ${context.firstName} by first name. ` +
      (context.addresses.length > 1
        ? "Ask which address on file the visit is for."
        : "Confirm the service address by reading back the street and unit only."),
  };
}

export const lookupCustomerTool = defineTool({
  schema: lookupCustomerSchema,
  async handler(args, ctx) {
    const raw = args.phone ?? ctx.callerPhone;
    if (!raw) {
      return {
        ok: false,
        errorCode: "missing_phone",
        message: "No phone number provided and caller ID is unavailable.",
        say: "Ask the caller for the phone number on their account.",
      };
    }
    const phoneE164 = normalizePhoneE164(raw);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Invalid: phone (not a valid phone number)",
        say: "That number didn't look right. Ask the caller to repeat the phone number on their account, including area code.",
        data: { invalid_fields: [{ field: "phone", problem: "not a valid phone number" }] },
      };
    }
    const { context, dbMs } = await getCallerContext(phoneE164, ctx.repos.customers);
    logEvent("caller_context", { callId: ctx.callId, found: context.found, db_ms: dbMs });
    return toLookupResult(context);
  },
});
