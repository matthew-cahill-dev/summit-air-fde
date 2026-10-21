import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { intakeSentences, propertySentence } from "@/server/scheduling/technician-notes";
import { propertyKind } from "@/server/triage/property";
import { ISSUE_TYPES, VULNERABLE_OCCUPANTS } from "@/server/triage/rules";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { intakeDetails, intakeRecord, technicianIntakeShape } from "./intake";
import { zipSchema } from "./triage-issue";

export const createPriorityDispatchSchema = z
  .object({
    // With customer_id (a verified caller), name and phone come from the account and
    // address_id can stand in for the address.
    first_name: optionalArg(z.string().trim().min(1)),
    last_name: optionalArg(z.string().trim().min(1)),
    phone: optionalArg(z.string().trim().min(1)),
    customer_id: optionalArg(z.uuid()),
    address_id: optionalArg(z.uuid()),
    address: optionalArg(
      z.object({
        line1: z.string().trim().min(3),
        unit: optionalArg(z.string().trim().min(1)),
        city: optionalArg(z.string().trim().min(1)),
        zip: zipSchema,
        access_notes: optionalArg(z.string().trim().min(1)),
      }),
    ),
    issue_type: z.enum(ISSUE_TYPES),
    issue_summary: z.string().trim().min(3),
    symptoms: z.array(z.string().trim().min(1)).default([]),
    ...technicianIntakeShape,
    vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
    indoor_temp_f: optionalArg(z.number().min(-20).max(130)),
    reasons: z.array(z.string().trim().min(1)).min(1),
  })
  .superRefine((v, ctx) => {
    if (!v.address && !v.address_id) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "address (or address_id from lookup_customer) is required" });
    }
    if (v.address_id && !v.customer_id) {
      ctx.addIssue({ code: "custom", path: ["customer_id"], message: "required with address_id" });
    }
  });

type DispatchArgs = z.infer<typeof createPriorityDispatchSchema>;

const invalid = (fields: Array<{ field: string; problem: string }>, say: string): ToolOutcome => ({
  ok: false,
  errorCode: "invalid_arguments",
  message: `Missing: ${fields.map((f) => f.field).join(", ")}`,
  say,
  data: { invalid_fields: fields },
});

/** Name, phone and address: what the caller said, else the verified account. */
async function resolveContact(args: DispatchArgs, ctx: ToolContext) {
  const account = args.customer_id ? await ctx.repos.customers.findCallerContextByCustomerId(args.customer_id) : null;
  const onFile = args.address_id ? account?.addresses.find((a) => a.id === args.address_id) : undefined;
  return {
    account,
    firstName: args.first_name ?? account?.customer.firstName ?? null,
    lastName: args.last_name ?? (args.first_name ? null : (account?.customer.lastName ?? null)),
    phoneE164: normalizePhoneE164(args.phone ?? ctx.callerPhone) ?? account?.customer.phoneE164 ?? null,
    address:
      args.address ??
      (onFile
        ? { line1: onFile.line1, unit: onFile.unit ?? undefined, city: onFile.city || undefined, zip: onFile.zip, access_notes: onFile.accessNotes ?? undefined }
        : null),
  };
}

export const createPriorityDispatchTool = defineTool({
  schema: createPriorityDispatchSchema,
  async handler(args, ctx) {
    const contact = await resolveContact(args, ctx);
    if (args.customer_id && !contact.account) return invalid([{ field: "customer_id", problem: "not found" }], "Next: ask for the caller's name and full address, then call create_priority_dispatch again without customer_id.");
    if (args.address_id && !contact.address) {
      return invalid([{ field: "address_id", problem: "not on this account" }], "Next: ask for the full service address, then call create_priority_dispatch again with it.");
    }
    if (!contact.firstName) return invalid([{ field: "first_name", problem: "required" }], "Next: ask for the caller's name, then call create_priority_dispatch again.");
    if (!contact.phoneE164) {
      return invalid([{ field: "phone", problem: "required" }], "Next: ask for the best number for the on-call team to call back, including area code, read it back in groups, then call create_priority_dispatch again.");
    }
    const property = ctx.callId ? propertyKind(await ctx.repos.toolInvocations.latestOkArgs(ctx.callId, "triage_issue")) : null;

    const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
    const existing = ctx.callId ? await ctx.repos.dispatch.findOpenForCall(ctx.callId, "emergency") : null;
    const { id } =
      existing ??
      (await ctx.repos.dispatch.create({
        customerId: args.customer_id ?? null,
        callerPhone: contact.phoneE164,
        callerName: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
        address: contact.address,
        urgency: "emergency",
        reasons: args.reasons,
        intake: {
          issue_type: args.issue_type,
          issue_summary: args.issue_summary,
          property_kind: property ?? "residential",
          symptoms: args.symptoms,
          ...intakeRecord(args),
          vulnerable_occupants: args.vulnerable_occupants,
          indoor_temp_f: args.indoor_temp_f ?? null,
          // The same technician paragraph a booking gets, for the on-call team.
          technician_notes: [
            propertySentence(property),
            ...intakeSentences({
              ...intakeDetails(args),
              symptoms: args.symptoms,
              vulnerableOccupants: args.vulnerable_occupants,
            }),
          ].join(" "),
        },
        vapiCallId: ctx.callId,
      }));
    return {
      ok: true,
      data: { dispatch_id: id, status: "open", callback_sla_minutes: sla, callback_phone: contact.phoneE164 },
      say: `The priority request is logged. Tell the caller that Summit Air's policy is for the on-call team to call them back within ${sla} minutes at the number they gave. Do NOT say a technician is assigned, dispatched or on the way. If anyone's health is at risk before then, they should call 911. Next: ask if there's anything else; don't book an appointment or create a callback for this problem.`,
    };
  },
});
