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
  preferred_callback_time: optionalArg(z.string().trim().min(2)),
  context: optionalArg(z.record(z.string(), z.unknown())),
});

/**
 * A second request on the same call adds to the first rather than replacing it: the newer
 * details win when they already include the older ones, otherwise both are kept.
 */
export function mergeDetails(previous: unknown, next: string): string {
  const prev = typeof previous === "string" ? previous.trim() : "";
  if (!prev || next.includes(prev)) return next;
  if (prev.includes(next)) return prev;
  return `${prev} Update: ${next}`;
}

/** A specific reason replaces "other"; otherwise the first reason on the call stands. */
export function mergeReason(previous: string | null, next: string): string {
  return !previous || previous === "other" ? next : previous;
}

export const createCallbackRequestTool = defineTool({
  schema: createCallbackRequestSchema,
  async handler(args, ctx) {
    const phoneE164 = normalizePhoneE164(args.phone ?? ctx.callerPhone);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Missing: phone",
        say: "Ask for the best callback number, including area code, and read it back in groups before trying again.",
        data: { invalid_fields: [{ field: "phone", problem: "required" }] },
      };
    }
    const extras = {
      ...(args.language ? { language: args.language } : {}),
      ...(args.preferred_callback_time ? { preferred_callback_time: args.preferred_callback_time } : {}),
    };
    const input = {
      callerPhone: phoneE164,
      callerName: args.caller_name ?? null,
      reason: args.reason,
      context: { details: args.details, ...args.context, ...extras },
    };

    // One open callback per call: a later request (a preferred time, a correction) updates it.
    const { id, updated } = ctx.callId
      ? await ctx.repos.callbacks.upsertOpenForCall({ ...input, vapiCallId: ctx.callId }, (existing) => ({
          callerPhone: args.phone ? phoneE164 : (existing.callerPhone ?? phoneE164),
          callerName: args.caller_name ?? existing.callerName,
          reason: mergeReason(existing.reason, args.reason),
          context: { ...existing.context, ...args.context, ...extras, details: mergeDetails(existing.context.details, args.details) },
        }))
      : { ...(await ctx.repos.callbacks.create({ ...input, vapiCallId: null })), updated: false };

    // One outcome per call: a callback on top of a booking must be for something the booking
    // doesn't cover, and the caller should hear what it's for.
    const callHasBooking = ctx.callId ? await ctx.repos.scheduling.hasConfirmedAppointmentForCall(ctx.callId) : false;
    return {
      ok: true,
      data: { callback_id: id, status: "open", updated, callback_phone: phoneE164, call_has_booking: callHasBooking },
      say:
        (callHasBooking
          ? "This call already has a confirmed booking. Tell the caller in one sentence what the office will call about (only what the booking doesn't cover). "
          : "") +
        (updated
          ? "The existing callback request for this call was updated (still one request). Confirm the change briefly."
          : `The callback request is logged. Tell the caller the office will call back during office hours (${BUSINESS.facts.officeHours}). Don't promise an exact time.`) +
        (args.preferred_callback_time ? " Mention the office will try for their preferred time but can't guarantee it." : "") +
        (args.language && !/^english$/i.test(args.language)
          ? ` Say it once in English, then once in simple ${args.language}: the office will call them back in ${args.language}.`
          : ""),
    };
  },
});
