import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { keepValid, keepValidObject } from "@/server/lib/fail-open";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import type { DispatchInput } from "@/server/repositories";
import { intakeSentences, propertySentence } from "@/server/scheduling/technician-notes";
import { detectSignals, hasSignals, signalPhrases } from "@/server/triage/detect";
import { propertyKind } from "@/server/triage/property";
import { ISSUE_TYPES, VULNERABLE_OCCUPANTS } from "@/server/triage/rules";
import { defineTool, type ToolContext } from "@/server/vapi/types";
import { intakeDetails, intakeRecord, technicianIntakeShape } from "./intake";
import { zipSchema } from "./triage-issue";

// Fails open (live call 01a15feb: refused for missing "reasons", then the call ended with no
// record). Everything but issue_summary is optional, invalid values are dropped instead of
// refused, and on a call with any emergency or safety sign even issue_summary is filled in.
// One record per call: a second call (or triage's automatic record) gets the new details merged.
const addressShape = {
  line1: optionalArg(z.string().trim().min(1)),
  unit: optionalArg(z.string().trim().min(1)),
  city: optionalArg(z.string().trim().min(1)),
  zip: optionalArg(zipSchema),
  access_notes: optionalArg(z.string().trim().min(1)),
};

const dispatchShape = {
  // With customer_id (a verified caller), name and phone come from the account and
  // address_id can stand in for the address.
  first_name: optionalArg(z.string().trim().min(1)),
  last_name: optionalArg(z.string().trim().min(1)),
  phone: optionalArg(z.string().trim().min(1)),
  customer_id: optionalArg(z.uuid()),
  address_id: optionalArg(z.uuid()),
  address: optionalArg(z.object(addressShape)),
  issue_type: optionalArg(z.enum(ISSUE_TYPES)),
  issue_summary: z.string().trim().min(3),
  symptoms: z.array(z.string().trim().min(1)).default([]),
  ...technicianIntakeShape,
  vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
  indoor_temp_f: optionalArg(z.number().min(-20).max(130)),
  reasons: z.array(z.string().trim().min(1)).default([]),
};

export const createPriorityDispatchSchema = z.object(dispatchShape);

type DispatchArgs = z.infer<typeof createPriorityDispatchSchema>;

const SAFETY_FLAGS = ["gas_smell", "co_alarm", "burning_smell_or_smoke", "co_symptoms", "medical_emergency"] as const;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * What this call already says about danger: flags the model sent, the caller's words (arguments
 * and the live transcript), triage's results on this call, and any safety record already made.
 */
export async function emergencyEvidence(raw: Record<string, unknown>, ctx: ToolContext) {
  const flagged = SAFETY_FLAGS.filter((f) => raw[f] === true);
  const words = [str(raw.caller_description), str(raw.issue_summary), ...(Array.isArray(raw.symptoms) ? raw.symptoms.map(str) : []), ctx.callerText ?? null]
    .filter(Boolean)
    .join(". ");
  const signals = detectSignals(words);
  const triaged = ctx.callId ? await ctx.repos.toolInvocations.okResults(ctx.callId, "triage_issue") : [];
  const urgentTriage = triaged.find((r) => r.urgency === "emergency" || r.urgency === "safety_stop") ?? null;
  const existing = ctx.callId ? await ctx.repos.dispatch.findSafetyOrEmergencyForCall(ctx.callId) : null;
  return {
    emergency: flagged.length > 0 || hasSignals(signals) || Boolean(urgentTriage) || Boolean(existing),
    detected: hasSignals(signals) ? signalPhrases(signals) : [],
    triageReasons: triaged.flatMap((r) => (Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === "string") : [])),
    description: str(raw.caller_description),
  };
}

/** Name, phone and address: what the caller said, else the verified account. Unknown ids are ignored, never refused. */
async function resolveContact(args: DispatchArgs, ctx: ToolContext) {
  const account = args.customer_id ? await ctx.repos.customers.findCallerContextByCustomerId(args.customer_id) : null;
  const onFile = args.address_id ? account?.addresses.find((a) => a.id === args.address_id) : undefined;
  if ((args.customer_id && !account) || (args.address_id && !onFile)) {
    logEvent("dispatch_ids_ignored", { callId: ctx.callId, customer_found: Boolean(account), address_on_file: Boolean(onFile) });
  }
  return {
    customerId: account ? args.customer_id! : null,
    firstName: args.first_name ?? account?.customer.firstName ?? null,
    lastName: args.last_name ?? (args.first_name ? null : (account?.customer.lastName ?? null)),
    phoneE164: normalizePhoneE164(args.phone ?? ctx.callerPhone ?? "") ?? account?.customer.phoneE164 ?? null,
    address:
      (onFile
        ? { line1: onFile.line1, unit: onFile.unit ?? undefined, city: onFile.city || undefined, zip: onFile.zip, access_notes: onFile.accessNotes ?? undefined }
        : null) ??
      args.address ??
      null,
  };
}

/** The shared write: the call's one priority record, created or (merge) given the new details. */
export function recordPriorityRequest(ctx: Pick<ToolContext, "repos" | "callId">, input: Omit<DispatchInput, "vapiCallId">) {
  return ctx.repos.dispatch.ensureForCall({ ...input, vapiCallId: ctx.callId }, "merge");
}

export const callbackPromise = (sla: number) =>
  `Summit Air's policy is for the on-call team to call them back within ${sla} minutes at the number they gave. Do NOT say a technician is assigned, dispatched or on the way.`;

export const createPriorityDispatchTool = defineTool({
  schema: createPriorityDispatchSchema,
  async prepare(raw, ctx) {
    const top = keepValid(dispatchShape, raw);
    const address = keepValidObject(addressShape, raw.address, "address");
    const args: Record<string, unknown> = { ...top.args };
    if ("address" in raw) {
      if (address.value) args.address = address.value;
      else delete args.address;
    }
    const dropped = [...top.dropped.filter((d) => d !== "address"), ...address.dropped];
    const notAsked: string[] = [];
    const hasSummary = typeof args.issue_summary === "string" && args.issue_summary.trim().length >= 3;
    const hasReasons = Array.isArray(args.reasons) && args.reasons.length > 0;
    if (!hasSummary || !hasReasons) {
      const evidence = await emergencyEvidence(raw, ctx);
      if (!hasReasons) {
        args.reasons = [
          ...new Set([
            ...evidence.triageReasons,
            ...(evidence.detected.length ? [`Detected in the caller's words: ${evidence.detected.join(", ")}`] : []),
          ]),
        ];
        if ((args.reasons as string[]).length === 0) args.reasons = ["Priority request logged by the assistant (no triage reasons given)"];
        notAsked.push("reasons");
      }
      if (!hasSummary && evidence.emergency) {
        args.issue_summary = evidence.description ?? "Emergency reported on the call (details not captured)";
        notAsked.push("issue_summary");
      }
    }
    return { args, failOpen: dropped.length || notAsked.length ? { dropped, notAsked } : null };
  },
  async handler(args, ctx) {
    const contact = await resolveContact(args, ctx);
    const property = ctx.callId ? propertyKind(await ctx.repos.toolInvocations.latestOkArgs(ctx.callId, "triage_issue")) : null;
    const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
    const issueType = args.issue_type ?? "other";
    const { id, created } = await recordPriorityRequest(ctx, {
      customerId: contact.customerId,
      callerPhone: contact.phoneE164,
      callerName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null,
      address: contact.address,
      urgency: "emergency",
      reasons: args.reasons,
      intake: {
        issue_type: issueType,
        issue_summary: args.issue_summary,
        property_kind: property ?? "residential",
        symptoms: args.symptoms,
        ...intakeRecord(args),
        vulnerable_occupants: args.vulnerable_occupants,
        indoor_temp_f: args.indoor_temp_f ?? null,
        ...(ctx.failOpen ? { not_asked: ctx.failOpen.notAsked, dropped_fields: ctx.failOpen.dropped } : {}),
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
    });
    logEvent("priority_dispatch_recorded", { callId: ctx.callId, created });
    return {
      ok: true,
      data: { dispatch_id: id, status: "open", callback_sla_minutes: sla, callback_phone: contact.phoneE164, updated_existing: !created },
      say: contact.phoneE164
        ? `The priority request is logged. Tell the caller that ${callbackPromise(sla)} If anyone's health is at risk before then, they should call 911. Next: ask if there's anything else; don't book an appointment or create a callback for this problem.`
        : `The priority request is logged, but there's no callback number. Next: ask only for the best number for the on-call team to call back, read it back in groups, then call create_priority_dispatch again with phone (it updates the same request). Then tell them the on-call team calls back within ${sla} minutes. If anyone's health is at risk, they should call 911.`,
    };
  },
});
