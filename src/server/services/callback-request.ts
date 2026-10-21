import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { defineTool } from "@/server/vapi/types";

export const CALLBACK_REASONS = ["backend_failure", "out_of_area", "human_requested", "incomplete_call", "other"] as const;

export const createCallbackRequestSchema = z.object({
  reason: z.enum(CALLBACK_REASONS),
  details: z.string().trim().min(3),
  caller_name: optionalArg(z.string().trim().min(1)),
  phone: optionalArg(z.string().trim().min(1)),
  language: optionalArg(z.string().trim().min(2)),
  context: optionalArg(z.record(z.string(), z.unknown())),
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
      context: { details: args.details, ...args.context, ...(args.language ? { language: args.language } : {}) },
      vapiCallId: ctx.callId,
    });
    return {
      ok: true,
      data: { callback_id: id, status: "open", callback_phone: phoneE164 },
      say:
        `The callback request is logged. Tell the caller the office will call back during office hours (${BUSINESS.facts.officeHours}). Don't promise an exact time.` +
        (args.language && !/^english$/i.test(args.language)
          ? ` Say it once in English, then once in simple ${args.language}: the office will call them back in ${args.language}.`
          : ""),
    };
  },
});
