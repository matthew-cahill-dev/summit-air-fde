// What happened on a call, derived from its tool_invocations and the records it
// created. Pure, so every outcome is unit-tested without a database.
import type {
  CallActivityRow,
  CallAppointmentRow,
  CallCallbackRow,
  CallDispatchRow,
  CallRecords,
  InvocationRow,
  Urgency,
} from "@/server/repositories";
import { issueLabel, isUrgency, URGENCY_RANK } from "./format";

export const CALL_OUTCOMES = [
  "safety_stop",
  "booked",
  "priority_dispatch",
  "callback",
  "not_serviceable",
  "incomplete",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  safety_stop: "Safety stop",
  booked: "Booked",
  priority_dispatch: "Priority dispatch",
  callback: "Callback",
  not_serviceable: "Not serviceable",
  incomplete: "Incomplete",
};

/**
 * A call with tool activity but no end-of-call report is "in progress" until it has
 * been quiet this long. Vapi caps calls at 15 minutes (maxDurationSeconds 900), so a
 * report that still hasn't arrived after that is missing, not pending.
 */
export const IN_PROGRESS_QUIET_MS = 20 * 60_000;

type CallEvidence = {
  invocations: Pick<InvocationRow, "toolName" | "ok" | "result">[];
  appointments: Pick<CallAppointmentRow, "status">[];
  dispatches: Pick<CallDispatchRow, "urgency">[];
  callbacks: Pick<CallCallbackRow, "status">[];
};

const okResults = (e: CallEvidence, tool: string) =>
  e.invocations.filter((i) => i.toolName === tool && i.ok).map((i) => i.result);

/**
 * Precedence, most significant first: safety stop > booked > priority dispatch >
 * callback > not serviceable > incomplete. Records are the source of truth; tool
 * results back them up (e.g. a safety stop whose dispatch row failed to save).
 */
export function deriveOutcome(e: CallEvidence): CallOutcome {
  const triage = okResults(e, "triage_issue");
  if (
    e.dispatches.some((d) => d.urgency === "safety_stop") ||
    triage.some((r) => r.next_action === "safety_instructions" || r.urgency === "safety_stop")
  ) {
    return "safety_stop";
  }
  if (
    e.appointments.some((a) => a.status === "confirmed") ||
    okResults(e, "book_appointment").some((r) => r.booked === true)
  ) {
    return "booked";
  }
  if (e.dispatches.some((d) => d.urgency === "emergency") || okResults(e, "create_priority_dispatch").length > 0) {
    return "priority_dispatch";
  }
  if (e.callbacks.length > 0 || okResults(e, "create_callback_request").length > 0) return "callback";
  if (
    triage.some((r) => r.next_action === "explain_and_close" || r.serviceable === false) ||
    okResults(e, "check_service_area").some((r) => r.serviceable === false)
  ) {
    return "not_serviceable";
  }
  return "incomplete";
}

export type CallStatus = "in_progress" | "ended" | "report_missing";

export function deriveCallStatus(
  call: Pick<CallActivityRow, "hasReport" | "lastActivityAt">,
  invocationCount: number,
  now: Date,
): CallStatus {
  if (call.hasReport) return "ended";
  if (invocationCount === 0) return "ended";
  const quietFor = call.lastActivityAt ? now.getTime() - call.lastActivityAt.getTime() : Infinity;
  return quietFor < IN_PROGRESS_QUIET_MS ? "in_progress" : "report_missing";
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type CallSummary = {
  vapiCallId: string;
  at: Date | null;
  callerName: string | null;
  callerPhone: string | null;
  issue: string | null;
  urgency: Urgency | null;
  reasons: string[];
  outcome: CallOutcome;
  status: CallStatus;
  isDemoSeed: boolean;
  toolCount: number;
  toolErrors: number;
};

/** One row of the calls list. `records` may hold other calls' rows; only this call's are used. */
export function summarizeCall(call: CallActivityRow, records: CallRecords, now: Date): CallSummary {
  const id = call.vapiCallId;
  const evidence = {
    invocations: records.invocations.filter((r) => r.vapiCallId === id),
    appointments: records.appointments.filter((r) => r.vapiCallId === id),
    dispatches: records.dispatches.filter((r) => r.vapiCallId === id),
    callbacks: records.callbacks.filter((r) => r.vapiCallId === id),
  };
  const triage = evidence.invocations.filter((i) => i.toolName === "triage_issue" && i.ok).at(-1);
  const bookingArgs = evidence.invocations.find((i) => i.toolName === "book_appointment" && i.ok)?.args;
  const lookup = evidence.invocations.filter((i) => i.toolName === "lookup_customer" && i.result.verified === true).at(-1);

  const callerName =
    nonEmpty(evidence.appointments[0]?.customerName) ??
    evidence.dispatches.map((d) => nonEmpty(d.callerName)).find(Boolean) ??
    evidence.callbacks.map((c) => nonEmpty(c.callerName)).find(Boolean) ??
    (bookingArgs ? nonEmpty([bookingArgs.first_name, bookingArgs.last_name].filter(Boolean).join(" ")) : null) ??
    nonEmpty(lookup?.result.first_name) ??
    null;
  const callerPhone =
    call.callerPhone ??
    evidence.dispatches.map((d) => d.callerPhone).find(Boolean) ??
    evidence.callbacks.map((c) => c.callerPhone).find(Boolean) ??
    evidence.appointments[0]?.customerPhone ??
    null;

  const recordUrgencies: Urgency[] = [
    ...evidence.dispatches.map((d) => d.urgency),
    ...evidence.appointments.map((a) => a.urgency),
  ];
  const triageUrgency = isUrgency(triage?.result.urgency) ? triage.result.urgency : null;
  const urgency =
    [triageUrgency, ...recordUrgencies]
      .filter((u): u is Urgency => u !== null)
      .sort((a, b) => URGENCY_RANK[a] - URGENCY_RANK[b])[0] ?? null;

  const issueSummary =
    nonEmpty(evidence.appointments[0]?.issueSummary) ??
    evidence.dispatches.map((d) => nonEmpty(d.intake?.issue_summary)).find(Boolean) ??
    evidence.callbacks.map((c) => nonEmpty(c.context?.details)).find(Boolean) ??
    null;
  const issueType = issueLabel(nonEmpty(triage?.args?.issue_type));

  const reasons = [
    ...(Array.isArray(triage?.result.reasons) ? (triage.result.reasons as unknown[]) : []),
    ...evidence.dispatches.flatMap((d) => d.reasons),
  ].filter((r): r is string => typeof r === "string");

  return {
    vapiCallId: id,
    at: call.startedAt ?? call.firstActivityAt ?? call.endedAt,
    callerName,
    callerPhone,
    issue: issueSummary ?? issueType,
    urgency,
    reasons: [...new Set(reasons)],
    outcome: deriveOutcome(evidence),
    status: deriveCallStatus(call, evidence.invocations.length, now),
    isDemoSeed: call.isDemoSeed,
    toolCount: evidence.invocations.length,
    toolErrors: evidence.invocations.filter((i) => !i.ok).length,
  };
}

/** Up to `max` scalar arguments worth showing in the timeline, e.g. "issue_type: no_heat". */
export function keyArgs(args: Record<string, unknown> | null, max = 5): Array<[string, string]> {
  if (!args) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(args)) {
    if (out.length >= max) break;
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) out.push([k, v.map(String).join(", ")]);
    } else if (typeof v === "object") {
      const parts = Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string" && x.trim());
      if (parts.length) out.push([k, parts.join(", ")]);
    } else {
      out.push([k, String(v)]);
    }
  }
  return out;
}
