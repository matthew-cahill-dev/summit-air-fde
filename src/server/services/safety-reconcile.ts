// Safety records that don't depend on the model. Two checks share one rule: if the caller's own
// words show gas, CO, smoke or medical-emergency signs (the same matcher triage uses), or triage
// marked the call emergency or safety stop, and the call has no safety-stop or priority record,
// one is created so it lands on the dispatch board, marked auto-detected. Idempotent per call.
//   - At hang-up (phone calls, phone-call-control): from Vapi's live transcript, before the
//     end-call goes out. Covers calls where no tool ran at all.
//   - After the call (end-of-call report): the final backstop. Phone calls only: chat
//     simulations get no end-of-call report (eval run 7021919d).
import { logEvent } from "@/server/lib/log";
import { normalizePhoneE164 } from "@/server/lib/phone";
import type { EndOfCallReport, Repositories, Urgency } from "@/server/repositories";
import { callerLines, detectSignals, hasSignals, signalPhrases } from "@/server/triage/detect";
import { callerTextOf } from "@/server/vapi/envelope";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The caller's words: transcript "User:" lines, else the report's user messages. */
export function callerText(report: Pick<EndOfCallReport, "transcript" | "rawReport">): string {
  const fromTranscript = callerLines(report.transcript);
  if (fromTranscript) return fromTranscript;
  const raw = isObj(report.rawReport) ? report.rawReport : {};
  const artifact = isObj(raw.artifact) ? raw.artifact : {};
  const messages = Array.isArray(artifact.messages) ? artifact.messages : Array.isArray(raw.messages) ? raw.messages : [];
  return messages
    .filter((m): m is Obj => isObj(m) && m.role === "user" && typeof m.message === "string")
    .map((m) => m.message as string)
    .join("\n");
}

export type Reconciliation = { created: boolean; dispatchId: string | null; detected: string[]; reason: string };

type SafetyRepos = Pick<Repositories, "dispatch" | "toolInvocations">;

const SOURCES = {
  transcript_reconciliation: "Auto-detected from transcript",
  hangup_safety_net: "Auto-detected at hang-up",
} as const;

/** Create the call's auto-detected safety record if the call needs one and has none. */
export async function ensureSafetyRecord(
  input: { vapiCallId: string; callerPhone: string | null; callerText: string; source: keyof typeof SOURCES },
  repos: SafetyRepos,
): Promise<Reconciliation> {
  const signals = detectSignals(input.callerText);
  const detected = hasSignals(signals) ? signalPhrases(signals) : [];
  const triaged = await repos.toolInvocations.okResults(input.vapiCallId, "triage_issue");
  const urgentTriage = triaged.find((r) => r.urgency === "safety_stop") ?? triaged.find((r) => r.urgency === "emergency") ?? null;
  if (!detected.length && !urgentTriage) return { created: false, dispatchId: null, detected, reason: "no signals" };
  const existing = await repos.dispatch.findSafetyOrEmergencyForCall(input.vapiCallId);
  if (existing) return { created: false, dispatchId: existing.id, detected, reason: "already recorded" };

  const hazard = signals.gas.length + signals.co.length + signals.smoke.length > 0;
  const urgency: Urgency = hazard || urgentTriage?.urgency === "safety_stop" ? "safety_stop" : "emergency";
  const triage = await repos.toolInvocations.latestOkArgs(input.vapiCallId, "triage_issue");
  const zip = typeof triage?.zip === "string" && triage.zip ? triage.zip : null;
  const label = SOURCES[input.source];
  const why = detected.length
    ? `${label}: ${detected.join(", ")}`
    : `${label}: triage marked this call ${String(urgentTriage!.urgency).replace("_", " ")}, but no priority request was logged`;
  const { id, created } = await repos.dispatch.ensureForCall(
    {
      customerId: typeof triage?.customer_id === "string" ? triage.customer_id : null,
      callerPhone: normalizePhoneE164(input.callerPhone ?? "") ?? input.callerPhone,
      callerName: null,
      address: zip ? { zip } : null,
      urgency,
      reasons: [why, "No safety record was made during the call: call the customer back now"],
      intake: {
        source: input.source,
        auto_detected: true,
        detected_signals: detected,
        flags: {
          gas_smell: signals.gas.length > 0,
          co_alarm: signals.co.length > 0,
          burning_smell_or_smoke: signals.smoke.length > 0,
          medical_emergency: signals.medical.length > 0,
        },
      },
      vapiCallId: input.vapiCallId,
    },
    "keep",
  );
  if (!created) return { created: false, dispatchId: id, detected, reason: "already recorded" };
  logEvent("safety_reconciled", { callId: input.vapiCallId, source: input.source, urgency, detected });
  return { created: true, dispatchId: id, detected, reason: "created" };
}

/** After the call, from the end-of-call report. */
export function reconcileSafety(report: Pick<EndOfCallReport, "vapiCallId" | "callerPhone" | "transcript" | "rawReport">, repos: SafetyRepos): Promise<Reconciliation> {
  return ensureSafetyRecord({ vapiCallId: report.vapiCallId, callerPhone: report.callerPhone, callerText: callerText(report), source: "transcript_reconciliation" }, repos);
}

/** At hang-up, from the phone-call-control message's live artifact. Null when the message has no call id. */
export async function safetyNetAtHangUp(message: Obj, repos: SafetyRepos): Promise<Reconciliation | null> {
  const call = isObj(message.call) ? message.call : {};
  const vapiCallId = typeof call.id === "string" && call.id ? call.id : null;
  if (!vapiCallId) return null;
  const customer = isObj(call.customer) ? call.customer : isObj(message.customer) ? message.customer : {};
  const callerPhone = typeof customer.number === "string" ? customer.number : null;
  return ensureSafetyRecord({ vapiCallId, callerPhone, callerText: callerTextOf(message) ?? "", source: "hangup_safety_net" }, repos);
}
