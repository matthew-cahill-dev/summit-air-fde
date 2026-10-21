// The dispatch priority board: open dispatch requests and callbacks in one queue,
// ordered by urgency then age, with SLA status. Pure.
import { BUSINESS } from "@/config/business";
import type { BoardCallbackRow, BoardDispatchRow, Urgency } from "@/server/repositories";
import {
  callbackReasonLabel,
  issueLabel,
  readAddress,
  readIssueType,
  readVulnerable,
  safetyTriggerLabel,
  URGENCY_RANK,
  type DisplayAddress,
} from "./format";

export type BoardItem = {
  kind: "dispatch" | "callback";
  id: string;
  urgency: Urgency | null;
  status: "open" | "acknowledged";
  title: string;
  reasons: string[];
  callerName: string | null;
  callerPhone: string | null;
  address: DisplayAddress | null;
  vulnerable: string[];
  issue: string | null;
  /** Technician intake paragraph (priority dispatch), e.g. "Started: last night. Already tried: ...". */
  notes: string | null;
  /** Callback in a language other than English, e.g. "Spanish". */
  language: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  ageMs: number;
  slaMinutes: number;
  /** Past the SLA and nobody has acknowledged it yet. */
  overdue: boolean;
  vapiCallId: string | null;
  isDemoSeed: boolean;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function dispatchItem(d: BoardDispatchRow, now: Date): BoardItem {
  const ageMs = now.getTime() - d.createdAt.getTime();
  const slaMinutes = BUSINESS.priorityDispatchCallbackSlaMinutes;
  const issueType = readIssueType(d.intake);
  return {
    kind: "dispatch",
    id: d.id,
    urgency: d.urgency,
    status: d.status === "acknowledged" ? "acknowledged" : "open",
    title: d.urgency === "safety_stop" ? "Safety stop follow-up" : "Priority dispatch",
    reasons: d.reasons,
    callerName: d.callerName ?? d.customerName,
    callerPhone: d.callerPhone ?? d.customerPhone,
    address: readAddress(d.address),
    vulnerable: readVulnerable(d.intake),
    issue:
      d.urgency === "safety_stop"
        ? (safetyTriggerLabel(d.intake, d.reasons) ?? (issueType && issueType !== "other" ? issueLabel(issueType) : "Safety concern"))
        : (str(d.intake?.issue_summary) ?? issueLabel(issueType)),
    notes: str(d.intake?.technician_notes),
    language: null,
    createdAt: d.createdAt,
    acknowledgedAt: d.acknowledgedAt,
    ageMs,
    slaMinutes,
    overdue: d.status === "open" && ageMs > slaMinutes * 60_000,
    vapiCallId: d.vapiCallId,
    isDemoSeed: d.isDemoSeed,
  };
}

export function callbackItem(c: BoardCallbackRow, now: Date): BoardItem {
  const ageMs = now.getTime() - c.createdAt.getTime();
  const slaMinutes = BUSINESS.callbackRequestSlaMinutes;
  const reasonLabel = callbackReasonLabel(c.reason);
  return {
    kind: "callback",
    id: c.id,
    urgency: c.triageUrgency,
    status: "open",
    title: `Callback · ${reasonLabel}`,
    reasons: c.triageReasons,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    address: readAddress(c.context?.address),
    vulnerable: readVulnerable(c.context),
    issue: str(c.context?.details) ?? issueLabel(readIssueType(c.context)),
    notes: null,
    language: str(c.context?.language),
    createdAt: c.createdAt,
    acknowledgedAt: null,
    ageMs,
    slaMinutes,
    overdue: ageMs > slaMinutes * 60_000,
    vapiCallId: c.vapiCallId,
    isDemoSeed: c.isDemoSeed,
  };
}

/** Callbacks without a triaged urgency sort after every triaged item. */
const rank = (u: Urgency | null) => (u ? URGENCY_RANK[u] : 99);

/** Safety stop, then emergency, then urgent (then the rest); oldest first within each. */
export function buildBoard(rows: { dispatches: BoardDispatchRow[]; callbacks: BoardCallbackRow[] }, now: Date): BoardItem[] {
  return [...rows.dispatches.map((d) => dispatchItem(d, now)), ...rows.callbacks.map((c) => callbackItem(c, now))].sort(
    (a, b) => rank(a.urgency) - rank(b.urgency) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}
