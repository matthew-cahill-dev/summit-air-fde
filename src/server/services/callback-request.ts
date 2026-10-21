import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { defineTool } from "@/server/vapi/types";

export const CALLBACK_REASONS = ["backend_failure", "out_of_area", "human_requested", "incomplete_call", "other"] as const;

export const createCallbackRequestSchema = z.object({
  reason: z.enum(CALLBACK_REASONS),
  details: z.string().trim().min(3),
  caller_name: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const createCallbackRequestTool = defineTool({
  schema: createCallbackRequestSchema,
  async handler(args, ctx) {
    const phoneE164 = normalizePhoneE164(args.phone ?? ctx.callerPhone);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Missing: phone",
        say: "Ask for the best callback number, including area code.",
        data: { invalid_fields: [{ field: "phone", problem: "required" }] },
      };
    }
    const { id } = await ctx.repos.callbacks.create({
      callerPhone: phoneE164,
      callerName: args.caller_name ?? null,
      reason: args.reason,
      context: { details: args.details, ...args.context },
      vapiCallId: ctx.callId,
    });
    return {
      ok: true,
      data: { callback_id: id, status: "open", callback_phone: phoneE164 },
      say: `The callback request is logged. Tell the caller the office will call back during office hours (${BUSINESS.facts.officeHours}). Don't promise an exact time.`,
    };
  },
});
