// Post-call safety reconciliation: the last line of defense. When a call ends, the caller's own
// words are scanned with the same matcher triage uses. If they show gas, CO, smoke or medical
// emergency signs and the call left no safety-stop or priority dispatch (the model gave the script
// but never called triage_issue, as in eval run 1e753a02), one is created so it lands on the
// dispatch board, marked auto-detected. Idempotent per call.
import { logEvent } from "@/server/lib/log";
import type { EndOfCallReport, Repositories, Urgency } from "@/server/repositories";
import { callerLines, detectSignals, hasSignals, signalPhrases } from "@/server/triage/detect";

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

export async function reconcileSafety(
  report: Pick<EndOfCallReport, "vapiCallId" | "callerPhone" | "transcript" | "rawReport">,
  repos: Pick<Repositories, "dispatch" | "toolInvocations">,
): Promise<Reconciliation> {
  const signals = detectSignals(callerText(report));
  if (!hasSignals(signals)) return { created: false, dispatchId: null, detected: [], reason: "no signals" };
  const detected = signalPhrases(signals);
  const existing = await repos.dispatch.findSafetyOrEmergencyForCall(report.vapiCallId);
  if (existing) return { created: false, dispatchId: existing.id, detected, reason: "already recorded" };

  const hazard = signals.gas.length + signals.co.length + signals.smoke.length > 0;
  const urgency: Urgency = hazard ? "safety_stop" : "emergency";
  const triage = await repos.toolInvocations.latestOkArgs(report.vapiCallId, "triage_issue");
  const zip = typeof triage?.zip === "string" && triage.zip ? triage.zip : null;
  const { id } = await repos.dispatch.create({
    customerId: typeof triage?.customer_id === "string" ? triage.customer_id : null,
    callerPhone: report.callerPhone,
    callerName: null,
    address: zip ? { zip } : null,
    urgency,
    reasons: [`Auto-detected from transcript: ${detected.join(", ")}`, "No safety record was made during the call: call the customer back now"],
    intake: {
      source: "transcript_reconciliation",
      auto_detected: true,
      detected_signals: detected,
      flags: {
        gas_smell: signals.gas.length > 0,
        co_alarm: signals.co.length > 0,
        burning_smell_or_smoke: signals.smoke.length > 0,
        medical_emergency: signals.medical.length > 0,
      },
    },
    vapiCallId: report.vapiCallId,
  });
  logEvent("safety_reconciled", { callId: report.vapiCallId, urgency, detected });
  return { created: true, dispatchId: id, detected, reason: "created" };
}
