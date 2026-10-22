import { z } from "zod";
import { BUSINESS, coverageOf } from "@/config/business";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { todayInZone } from "@/server/lib/time";
import { detectConcerns, detectSignals, hasSignals, involvesHeatingEquipment, signalPhrases, type Signals } from "@/server/triage/detect";
import { ISSUE_TYPES, triageRules, VULNERABLE_OCCUPANTS, type TriageDecision } from "@/server/triage/rules";
import { keepValid } from "@/server/lib/fail-open";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { defineTool, type FailOpen, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";
import { requireLookup } from "./lookup-guard";

export const zipSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, "must be a 5-digit ZIP code")
  .transform((v) => v.slice(0, 5));

export const preferredWindowSchema = z.enum(["morning", "afternoon", "any"]);

const triageShape = {
  issue_type: z.enum(ISSUE_TYPES),
  // Left out = not reported. Ava no longer asks every caller about gas and CO (client session 1:
  // "a caller would open with something that serious"); she listens on every call and asks only
  // on heating problems. Requiring them made triage refuse a no-heat call for a missing
  // burning_smell_or_smoke and cost an extra question (live call 01a1659e).
  gas_smell: optionalArg(z.boolean()),
  co_alarm: optionalArg(z.boolean()),
  burning_smell_or_smoke: optionalArg(z.boolean()),
  vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
  indoor_temp_f: optionalArg(z.number().min(-20).max(130)),
  property_type: z.enum(["residential", "commercial"]),
  multi_unit_central_system: optionalArg(z.boolean()),
  // The caller's own words about the problem and the people at home, near-verbatim. Scanned by a
  // deterministic matcher (src/server/triage/detect.ts) that can only escalate. Always sent; an
  // empty string never blocks triage.
  caller_description: z.string().trim(),
  co_symptoms: optionalArg(z.boolean()),
  medical_emergency: optionalArg(z.boolean()),
  water_near_electrical: optionalArg(z.boolean()),
  // A safety stop never waits for a ZIP (eval run 1b235efa: a gas call sent zip "", was refused,
  // and the safety follow-up was never recorded). Every other triage needs it.
  zip: optionalArg(zipSchema),
  customer_id: optionalArg(z.uuid()),
  preferred_window: optionalArg(preferredWindowSchema),
};

/** Any safety or medical sign: a flag the model set, or the matcher on the caller's words. */
export function emergencySigns(v: Record<string, unknown>): boolean {
  return (
    SAFETY_FLAGS.some((f) => v[f] === true) || hasSignals(detectSignals(typeof v.caller_description === "string" ? v.caller_description : ""))
  );
}

const SAFETY_FLAGS = ["gas_smell", "co_alarm", "burning_smell_or_smoke", "co_symptoms", "medical_emergency"] as const;

export const triageIssueSchema = z.object(triageShape).superRefine((v, ctx) => {
  // An emergency or safety call never waits for a ZIP (live call 01a15feb: the caller didn't know it).
  if (!v.zip && !emergencySigns(v)) ctx.addIssue({ code: "custom", path: ["zip"], message: "required (ask for the ZIP; never guess one)" });
});

/**
 * Emergency and safety calls fail open (live call 01a15feb: a medical emergency was refused for a
 * missing burning_smell_or_smoke, then for a missing ZIP). A missing safety question counts as
 * "no, not asked"; anything invalid is dropped; issue and property type get safe defaults.
 */
export async function prepareTriage(raw: Record<string, unknown>): Promise<{ args: Record<string, unknown>; failOpen: FailOpen | null }> {
  if (!emergencySigns(raw)) return { args: raw, failOpen: null };
  const { args, dropped } = keepValid(triageShape, raw);
  const notAsked: string[] = [];
  for (const f of ["gas_smell", "co_alarm", "burning_smell_or_smoke"] as const) {
    if (typeof args[f] !== "boolean") {
      args[f] = false;
      if (!dropped.includes(f)) notAsked.push(f);
    }
  }
  if (Array.isArray(raw.vulnerable_occupants)) {
    args.vulnerable_occupants = raw.vulnerable_occupants.filter((v) => (VULNERABLE_OCCUPANTS as readonly unknown[]).includes(v));
  }
  if (!(ISSUE_TYPES as readonly unknown[]).includes(args.issue_type)) args.issue_type = "other";
  if (args.property_type !== "residential" && args.property_type !== "commercial") args.property_type = "residential";
  if (typeof args.caller_description !== "string") args.caller_description = "";
  if (!args.zip) notAsked.push("zip");
  return { args, failOpen: notAsked.length || dropped.length ? { notAsked, dropped } : null };
}

type TriageArgs = z.infer<typeof triageIssueSchema>;

/**
 * The model's flags, escalated by what the caller actually said: a phrase match forces the flag on
 * (never off). Eval run 1e753a02: "she's kind of confused and not making sense" came with no
 * medical_emergency flag and was booked as routine no-AC.
 */
export function applySignals(args: TriageArgs, s: Signals): TriageArgs & { gas_smell: boolean; co_alarm: boolean; burning_smell_or_smoke: boolean } {
  return {
    ...args,
    gas_smell: args.gas_smell === true || s.gas.length > 0,
    co_alarm: args.co_alarm === true || s.co.length > 0,
    burning_smell_or_smoke: args.burning_smell_or_smoke === true || s.smoke.length > 0,
    medical_emergency: args.medical_emergency === true || s.medical.length > 0,
  };
}

const SAFETY_SAY =
  "Give the gas and carbon monoxide safety instructions now: leave the home with everyone, don't touch switches or flames, don't use a phone inside, and call 911 from outside. Do not book an appointment. Say clearly that Summit Air has NOT contacted 911, the fire department or the gas utility; the caller must call 911 themselves.";
const SAFETY_NEXT =
  " Next: no technician questions. If they won't leave, calmly repeat once that they need to get out and call 911 from outside. Once they acknowledge, end the call (endCall) so they can go.";

/**
 * After the caller picks a window: one open question for the technician, not a checklist. Client
 * session 1: confirm, don't interrogate (the old five-question list took about a minute on live
 * calls 01a16568 and 01a1659e). What they've already said (onset, equipment, what they tried) is
 * still passed to book_appointment.
 */
export function technicianEssentials(verified: boolean): string {
  return (
    "After they pick one, ask just one more question: \"Anything the technician should know, like pets or how to get in?\" Don't ask about when it started, the equipment or what they've tried; pass along whatever they've already said. " +
    (verified ? "" : "If you don't have their first and last name yet, ask for it and spell the last name back to confirm it. ") +
    "Then read back the window, address and problem" +
    (verified ? "" : ", and their name") +
    " in one sentence ending \"Sound good?\", wait for a clear yes, and only then call book_appointment with caller_confirmed true and everything they told you."
  );
}

/**
 * Words that might mean someone is unwell (detectConcerns). One gentle question before anything
 * else; a yes re-triages as a medical emergency.
 */
export function concernSay(phrases: string[]): string {
  return (
    `The caller said ${phrases.map((p) => `"${p}"`).join(", ")}. Before offering times, ask once, gently: "Is anyone at home feeling unwell, like dizzy, confused or having trouble breathing?" ` +
    "If yes, your next words are \"Please call nine one one now,\" then call triage_issue again with medical_emergency true and their words in caller_description. If no, carry on. "
  );
}

/** A heating call where gas and CO weren't reported either way: the one place the screen is still asked. */
export const HEATING_SCREEN_SAY =
  "This is a heating problem and gas and carbon monoxide haven't come up. Before offering times, if you haven't already, ask once: \"Just to be safe, do you smell gas, or is a carbon monoxide alarm going off?\" If yes, give the safety instructions and call triage_issue again with the flag. If no, carry on. ";

/** Said first when the flags call for it, before the next step. */
function safetyPreface(args: { medical_emergency?: boolean; water_near_electrical?: boolean }): string {
  return (
    (args.medical_emergency
      ? "Medical emergency signs: if you haven't already, tell them in one calm sentence to call nine one one now. No medical advice beyond that. "
      : "") +
    (args.water_near_electrical
      ? "Water near electrical equipment: tell them to stay clear of it and, only if they can reach it safely, switch that circuit off at the breaker. "
      : "")
  );
}

export const OFFICE_REVIEW_CALLBACK = { reason: "other", details: "multi-unit/central system, office to review" } as const;
export const coverageCheckCallback = (borough: string) => ({ reason: "other", details: `coverage check: ${borough}` }) as const;

/**
 * The safety-stop or medical-emergency record, made by triage itself so it never depends on the
 * model calling another tool. One per call (merged). Best effort: false if the database failed.
 */
async function recordFromTriage(args: TriageArgs, decision: TriageDecision, ctx: ToolContext, urgency: "safety_stop" | "emergency"): Promise<string | null> {
  try {
    // A safety stop already on the call stays as it was recorded.
    if (urgency === "safety_stop" && ctx.callId) {
      const open = await ctx.repos.dispatch.findOpenForCall(ctx.callId, "safety_stop");
      if (open) return open.id;
    }
    // The same per-call record create_priority_dispatch writes (and merges into).
    const { id } = await ctx.repos.dispatch.ensureForCall({
      customerId: args.customer_id ?? null,
      callerPhone: normalizePhoneE164(ctx.callerPhone ?? "") ?? ctx.callerPhone,
      callerName: null,
      address: args.zip ? { zip: args.zip } : null,
      urgency,
      reasons: decision.reasons,
      intake: {
        source: "triage_issue",
        flags: args,
        issue_type: args.issue_type,
        issue_summary: args.caller_description || null,
        vulnerable_occupants: args.vulnerable_occupants,
        ...(ctx.failOpen ? { not_asked: ctx.failOpen.notAsked, dropped_fields: ctx.failOpen.dropped } : {}),
      },
      vapiCallId: ctx.callId,
    }, "merge");
    return id;
  } catch (err) {
    logEvent("triage_record_failed", { callId: ctx.callId, urgency, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Medical emergency: 911 first, the on-call team already alerted, and nothing that stalls or ends the call. */
export function medicalSay(o: { recorded: boolean; hasPhone: boolean; waterNearElectrical?: boolean }): string {
  const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
  const next = !o.recorded
    ? `Next: ask only for the best callback number, then call create_priority_dispatch with it and the problem; that logs the priority request. Then say the on-call team will call them back within ${sla} minutes. `
    : o.hasPhone
      ? `The on-call team has been alerted: the priority request is already logged. Tell them in one short sentence that our on-call team will call them back at this number within ${sla} minutes, and that 911 comes first. Don't say a technician is on the way. `
      : `The priority request is already logged, but there's no caller ID. Next: ask only for the best callback number, then call create_priority_dispatch with phone (it updates the same request), and say the on-call team will call them back within ${sla} minutes; 911 comes first. `;
  return (
    safetyPreface({ medical_emergency: true, water_near_electrical: o.waterNearElectrical }) +
    next +
    "Ask for nothing else, and don't tell them to call back later. If they offer a ZIP, address or name, call create_priority_dispatch with it (it updates the same request). Never book. Never end the call yourself unless the caller says goodbye or that they need to go."
  );
}

/**
 * Priority dispatch (an emergency with no medical signs, e.g. no heat with an elderly parent). The
 * request is already logged by triage, so Ava confirms instead of interviewing: the callback number
 * (caller ID when there is one) and, for an unverified caller, name and street. Who's home, access
 * and equipment wait for the on-call team's callback (client session 1: get emergencies off the
 * phone faster).
 */
export function prioritySay(o: { recorded: boolean; hasPhone: boolean; verified: boolean; offerTransfer: boolean }): string {
  const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
  const number = o.hasPhone
    ? "confirm the callback number in one question (\"Can the on-call team call you back at the number you're calling from?\"); only if they say no, ask for the best number"
    : "ask for the best callback number and read it back in groups";
  const who = o.verified ? "" : " Then, if you don't have them yet, get their name and the street address.";
  return (
    "This qualifies for priority dispatch: say it needs priority attention. " +
    (o.recorded ? "The priority request is already logged for the on-call team. " : "") +
    `Next: ${number}.${who} Ask nothing else: who's at home, access and the equipment are covered on the callback. ` +
    `Then call create_priority_dispatch with what they gave you (verified: customer_id and address_id)${o.recorded ? "; it updates the same request" : "; that logs the priority request"}. ` +
    `Then say the on-call team will call them back within ${sla} minutes.` +
    (o.offerTransfer ? " After it succeeds, offer to connect them to the on-call team now." : "")
  );
}

export const triageIssueTool = defineTool({
  schema: triageIssueSchema,
  prepare: (raw) => prepareTriage(raw),
  async handler(modelArgs, ctx): Promise<ToolOutcome> {
    const signals = detectSignals(modelArgs.caller_description);
    const args = applySignals(modelArgs, signals);
    const detected = hasSignals(signals) ? signalPhrases(signals) : [];
    if (detected.length) logEvent("triage_signals_detected", { callId: ctx.callId, detected, model_flags_missed: SAFETY_FLAGS.some((f) => args[f] === true && modelArgs[f] !== true) });
    const zipRow = args.zip ? await ctx.repos.serviceArea.findZip(args.zip) : null;
    // A medical emergency without a ZIP isn't "out of area": the on-call team sorts the address out.
    const zipUnknown = !args.zip && args.medical_emergency === true;
    const cov = zipUnknown ? ({ coverage: "in_area", county: null, borough: null } as const) : coverageOf(zipRow);
    const area = {
      zip: args.zip ?? "",
      inArea: cov.coverage === "in_area",
      county: cov.coverage === "in_area" ? cov.county : null,
      coverage: cov.coverage,
      borough: cov.borough,
    };
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
        coSymptoms: args.co_symptoms ?? false,
        medicalEmergency: args.medical_emergency ?? false,
        waterNearElectrical: args.water_near_electrical ?? false,
      },
      area,
      todayInZone(ctx.settings.timeZone, ctx.now),
    );
    // Membership is checked first on every routine or urgent home call. Businesses, safety stops and
    // emergencies never wait on it: the on-call team sorts the account out on the callback.
    const emergency = decision.urgency === "emergency" || decision.urgency === "safety_stop";
    if (args.property_type !== "commercial" && !emergency) {
      const blocked = await requireLookup(ctx, "triage_issue");
      if (blocked) return blocked;
    }
    if (detected.length) decision.reasons.push(`Detected in the caller's words: ${detected.join(", ")}`);
    if (zipUnknown) decision.reasons.push("ZIP not given: confirm the address on the callback");
    // Every medical emergency and every priority dispatch lands on the dispatch board now, whatever
    // the model does next; create_priority_dispatch only adds details to the same record.
    const priorityRecord =
      decision.nextAction !== "safety_instructions" && (args.medical_emergency === true || decision.nextAction === "priority_dispatch")
        ? await recordFromTriage(args, decision, ctx, "emergency")
        : null;
    const hasPhone = Boolean(normalizePhoneE164(ctx.callerPhone ?? ""));
    // Safety flags the model left out (not asked, nothing heard): kept on the result for the audit trail.
    const notReported = (["gas_smell", "co_alarm", "burning_smell_or_smoke"] as const).filter((f) => typeof modelArgs[f] !== "boolean");
    const base = {
      urgency: decision.urgency,
      reasons: decision.reasons,
      ...(detected.length ? { detected_signals: detected } : {}),
      serviceable: decision.serviceable,
      ...(decision.notServiceableReason ? { not_serviceable_reason: decision.notServiceableReason } : {}),
      in_area: area.inArea,
      coverage: cov.coverage,
      county: area.county,
      ...(ctx.failOpen?.notAsked.length ? { not_asked: ctx.failOpen.notAsked } : {}),
      ...(priorityRecord ? { priority_request_logged: true, dispatch_id: priorityRecord } : {}),
      ...(notReported.length ? { safety_not_reported: notReported } : {}),
    };

    if (decision.nextAction === "safety_instructions") {
      // Safety guidance never depends on the database; the follow-up record is best effort.
      const recorded = (await recordFromTriage(args, decision, ctx, "safety_stop")) !== null;
      return {
        ok: true,
        data: { ...base, next_action: "safety_instructions", office_followup_recorded: recorded },
        say:
          SAFETY_SAY +
          (recorded
            ? " You may say the Summit Air office has a note to follow up once they're safe."
            : " Do not say the office was notified.") +
          SAFETY_NEXT,
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
        say:
          safetyPreface(args) +
          (commercial
            ? BUSINESS.commercialReferrals
              ? "Kindly explain Summit Air only services homes. Next: offer an office callback with referrals to commercial HVAC companies (create_callback_request, reason other, details 'commercial referral')."
              : "Kindly explain Summit Air only services homes, so they'll want a commercial HVAC company. Give no other reason (no licensing, insurance or policy talk), and don't offer a referral or a callback. Next: thank them and end the call."
            : `Confirm the ZIP once. If it's right, explain we only serve homes in ${BUSINESS.facts.serviceArea}. If anyone's health is at risk, they should call 911. ` +
              "Next: if they say the ZIP or address was misheard, call triage_issue again with the corrected ZIP; otherwise ask if there's anything else, then end the call."),
      };
    }

    if (decision.nextAction === "office_review" && decision.notServiceableReason === "coverage_unconfirmed") {
      const borough = cov.borough ?? cov.county ?? args.zip ?? "that borough";
      return {
        ok: true,
        data: { ...base, next_action: "office_review", coverage_check: true, borough, callback: coverageCheckCallback(borough) },
        say:
          safetyPreface(args) +
          `Don't book or offer times. Say: "Let me have our office confirm whether we can cover that address." Don't give a reason and don't say we don't serve ${borough}. ` +
          `Next: get their name and best callback number, then call create_callback_request with reason other and details starting "coverage check: ${borough}", plus the address and the problem. No technician questions.` +
          (decision.urgency === "emergency" || decision.urgency === "urgent" ? " If anyone's health is at risk before the office calls, they should call 911." : ""),
      };
    }

    if (decision.nextAction === "office_review") {
      return {
        ok: true,
        data: { ...base, next_action: "office_review", callback: OFFICE_REVIEW_CALLBACK },
        say:
          safetyPreface(args) +
          "Don't book. Explain kindly that building-wide systems serving several units are reviewed by the office before anyone is scheduled. " +
          "Next: get their name and best callback number, then call create_callback_request with reason other and details starting 'multi-unit/central system, office to review', plus the address and problem. No technician questions.",
      };
    }

    if (decision.nextAction === "priority_dispatch" && args.medical_emergency) {
      return {
        ok: true,
        data: { ...base, next_action: "priority_dispatch", priority_request_logged: priorityRecord !== null },
        say: medicalSay({
          recorded: priorityRecord !== null,
          hasPhone,
          waterNearElectrical: args.water_near_electrical,
        }),
      };
    }

    if (decision.nextAction === "priority_dispatch") {
      const offerTransfer = ctx.settings.transferAvailable;
      return {
        ok: true,
        data: { ...base, next_action: "priority_dispatch", offer_transfer: offerTransfer, priority_request_logged: priorityRecord !== null },
        say: safetyPreface(args) + prioritySay({ recorded: priorityRecord !== null, hasPhone, verified: Boolean(args.customer_id), offerTransfer }),
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

    // Before any times: one question if the caller sounded unwell, and the gas/CO check on a heating
    // call that hasn't had it.
    const concerns = args.medical_emergency ? [] : detectConcerns([args.caller_description, ctx.callerText].filter(Boolean).join("\n"));
    const heatingScreen =
      involvesHeatingEquipment(args.issue_type, args.caller_description) && typeof modelArgs.gas_smell !== "boolean" && typeof modelArgs.co_alarm !== "boolean";
    if (concerns.length) logEvent("triage_concerns_detected", { callId: ctx.callId, concerns });
    const checks = (concerns.length ? concernSay(concerns) : "") + (heatingScreen ? HEATING_SCREEN_SAY : "");
    const checkData = { ...(concerns.length ? { possible_concerns: concerns } : {}), ...(heatingScreen ? { heating_safety_screen: true } : {}) };

    if (selection.slots.length === 0) {
      return {
        ok: true,
        data: { ...base, ...checkData, next_action: "create_callback", offered_slots: [] },
        say:
          safetyPreface(args) +
          checks +
          "There are no open arrival windows right now. Apologize once. Next: offer a callback from the office to schedule, and call create_callback_request (reason other, details with the problem) if they agree.",
      };
    }
    return {
      ok: true,
      data: {
        ...base,
        ...checkData,
        next_action: decision.nextAction,
        offered_slots: selection.slots,
        slots_within_target: selection.withinTarget,
        preference_matched: selection.preferenceMatched,
      },
      say:
        safetyPreface(args) +
        checks +
        (urgency === "urgent" && !selection.withinTarget
          ? "Nothing is open in the next 48 hours; apologize and offer these later windows. "
          : "") +
        (selection.preferenceMatched ? "" : "Nothing matched their preferred time; say so and offer these instead. ") +
        "Next: offer these windows now, one or two at a time, using the label wording. If none work, call get_availability. " +
        technicianEssentials(Boolean(args.customer_id)),
    };
  },
});
