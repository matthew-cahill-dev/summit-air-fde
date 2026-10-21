import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { intakeSentences } from "@/server/scheduling/technician-notes";
import { ISSUE_TYPES, VULNERABLE_OCCUPANTS } from "@/server/triage/rules";
import { defineTool } from "@/server/vapi/types";
import { intakeDetails, intakeRecord, technicianIntakeShape } from "./intake";
import { zipSchema } from "./triage-issue";

export const createPriorityDispatchSchema = z.object({
  first_name: z.string().trim().min(1),
  last_name: optionalArg(z.string().trim().min(1)),
  phone: optionalArg(z.string().trim().min(1)),
  customer_id: optionalArg(z.uuid()),
  address: z.object({
    line1: z.string().trim().min(3),
    unit: optionalArg(z.string().trim().min(1)),
    city: optionalArg(z.string().trim().min(1)),
    zip: zipSchema,
    access_notes: optionalArg(z.string().trim().min(1)),
  }),
  issue_type: z.enum(ISSUE_TYPES),
  issue_summary: z.string().trim().min(3),
  symptoms: z.array(z.string().trim().min(1)).default([]),
  ...technicianIntakeShape,
  vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
  indoor_temp_f: optionalArg(z.number().min(-20).max(130)),
  reasons: z.array(z.string().trim().min(1)).min(1),
});

export const createPriorityDispatchTool = defineTool({
  schema: createPriorityDispatchSchema,
  async handler(args, ctx) {
    const phoneE164 = normalizePhoneE164(args.phone ?? ctx.callerPhone);
    if (!phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Missing: phone",
        say: "Ask for the best number for the on-call team to call back, including area code.",
        data: { invalid_fields: [{ field: "phone", problem: "required" }] },
      };
    }
    const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
    const existing = ctx.callId ? await ctx.repos.dispatch.findOpenForCall(ctx.callId, "emergency") : null;
    const { id } =
      existing ??
      (await ctx.repos.dispatch.create({
        customerId: args.customer_id ?? null,
        callerPhone: phoneE164,
        callerName: [args.first_name, args.last_name].filter(Boolean).join(" "),
        address: args.address,
        urgency: "emergency",
        reasons: args.reasons,
        intake: {
          issue_type: args.issue_type,
          issue_summary: args.issue_summary,
          symptoms: args.symptoms,
          ...intakeRecord(args),
          vulnerable_occupants: args.vulnerable_occupants,
          indoor_temp_f: args.indoor_temp_f ?? null,
          // The same technician paragraph a booking gets, for the on-call team.
          technician_notes: intakeSentences({
            ...intakeDetails(args),
            symptoms: args.symptoms,
            vulnerableOccupants: args.vulnerable_occupants,
          }).join(" "),
        },
        vapiCallId: ctx.callId,
      }));
    return {
      ok: true,
      data: { dispatch_id: id, status: "open", callback_sla_minutes: sla, callback_phone: phoneE164 },
      say: `The priority request is logged. Tell the caller that Summit Air's policy is for the on-call team to call them back within ${sla} minutes at the number they gave. Do NOT say a technician is assigned, dispatched or on the way. If anyone's health is at risk before then, they should call 911.`,
    };
  },
});
