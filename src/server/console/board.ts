// The dispatch priority board: open dispatch requests and callbacks in one queue,
// ordered by urgency then age, with SLA status. Pure.
import { BUSINESS } from "@/config/business";
import { PROPERTY_LABEL, propertyKind, type PropertyKind } from "@/server/triage/property";
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

/** New → Called back (stops the callback SLA) → Resolved (with an outcome). */
export type BoardStage = "new" | "called_back" | "resolved";

export const STAGE_LABEL: Record<BoardStage, string> = { new: "New", called_back: "Called back", resolved: "Resolved" };

/** Why an item was resolved. Shown on the board, the call page and the activity feed. */
export const RESOLUTIONS = [
  "Technician dispatched",
  "Appointment booked",
  "Customer resolved it",
  "No answer, will retry",
  "Not serviceable",
  "Other",
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export type BoardItem = {
  kind: "dispatch" | "callback";
  id: string;
  urgency: Urgency | null;
  stage: BoardStage;
  calledBackAt: Date | null;
  calledBackBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  /** Reschedule/cancel callbacks: the customer's scheduled appointment, and what they asked for. */
  appointmentId: string | null;
  appointmentAction: "reschedule" | "cancel" | null;
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
  /** "Residential", "Commercial" or "Multi-unit", when triage recorded it. */
  property: string | null;
  /** Callback: when the caller would like to be called, in their words. */
  preferredTime: string | null;
  /** Callback: a Bronx / Staten Island address the office must confirm coverage for (the borough). */
  coverageCheck: string | null;
  createdAt: Date;
  ageMs: number;
  slaMinutes: number;
  /** Past the SLA and nobody has called back yet. */
  overdue: boolean;
  vapiCallId: string | null;
  isDemoSeed: boolean;
  /** Created after the call from the caller's words (post-call safety reconciliation), not by Ava. */
  autoDetected: boolean;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function dispatchItem(d: BoardDispatchRow, now: Date): BoardItem {
  const ageMs = now.getTime() - d.createdAt.getTime();
  const slaMinutes = BUSINESS.priorityDispatchCallbackSlaMinutes;
  const issueType = readIssueType(d.intake);
  const stage: BoardStage = d.status === "resolved" ? "resolved" : d.status === "acknowledged" ? "called_back" : "new";
  return {
    kind: "dispatch",
    id: d.id,
    urgency: d.urgency,
    stage,
    calledBackAt: d.acknowledgedAt,
    calledBackBy: d.acknowledgedBy,
    resolvedAt: d.resolvedAt,
    resolution: d.resolution,
    resolutionNote: d.resolutionNote,
    resolvedBy: d.resolvedBy,
    appointmentId: null,
    appointmentAction: null,
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
    property: propertyText(d.intake?.property_kind, d.intake?.flags),
    preferredTime: null,
    coverageCheck: null,
    createdAt: d.createdAt,
    ageMs,
    slaMinutes,
    overdue: stage === "new" && ageMs > slaMinutes * 60_000,
    vapiCallId: d.vapiCallId,
    isDemoSeed: d.isDemoSeed,
    autoDetected: d.intake?.auto_detected === true,
  };
}

export function callbackItem(c: BoardCallbackRow, now: Date): BoardItem {
  const ageMs = now.getTime() - c.createdAt.getTime();
  const slaMinutes = BUSINESS.callbackRequestSlaMinutes;
  const reasonLabel = callbackReasonLabel(c.reason);
  const coverageCheck = c.context?.kind === "coverage_check" ? (str(c.context?.borough) ?? "unknown borough") : null;
  const stage: BoardStage = c.status === "done" ? "resolved" : c.calledBackAt ? "called_back" : "new";
  const details = str(c.context?.details) ?? "";
  const appointmentAction = /\bcancel/i.test(details) ? "cancel" : /\b(reschedul|move|change)\w*/i.test(details) ? "reschedule" : null;
  return {
    kind: "callback",
    id: c.id,
    urgency: c.triageUrgency,
    stage,
    calledBackAt: c.calledBackAt,
    calledBackBy: c.calledBackBy,
    resolvedAt: c.resolvedAt,
    resolution: c.resolution,
    resolutionNote: c.resolutionNote,
    resolvedBy: c.resolvedBy,
    appointmentId: appointmentAction ? c.appointmentId : null,
    appointmentAction: c.appointmentId ? appointmentAction : null,
    title: coverageCheck ? `Confirm coverage · ${coverageCheck}` : `Callback · ${reasonLabel}`,
    reasons: c.triageReasons,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    address: readAddress(c.context?.address),
    vulnerable: readVulnerable(c.context),
    issue: str(c.context?.details) ?? issueLabel(readIssueType(c.context)),
    notes: null,
    language: str(c.context?.language),
    property: propertyText(null, c.triageArgs),
    preferredTime: str(c.context?.preferred_callback_time),
    coverageCheck,
    createdAt: c.createdAt,
    ageMs,
    slaMinutes,
    overdue: stage === "new" && ageMs > slaMinutes * 60_000,
    vapiCallId: c.vapiCallId,
    isDemoSeed: c.isDemoSeed,
    autoDetected: false,
  };
}

/** A stored property kind (priority dispatch intake), else derived from triage arguments. */
function propertyText(stored: unknown, triageArgs: unknown): string | null {
  const kind = typeof stored === "string" && stored in PROPERTY_LABEL ? (stored as PropertyKind) : propertyKind(triageArgs);
  return kind ? PROPERTY_LABEL[kind] : null;
}

/** Callbacks without a triaged urgency sort after every triaged item. */
const rank = (u: Urgency | null) => (u ? URGENCY_RANK[u] : 99);

/** Safety stop, then emergency, then urgent (then the rest); oldest first within each. */
export function buildBoard(rows: { dispatches: BoardDispatchRow[]; callbacks: BoardCallbackRow[] }, now: Date): BoardItem[] {
  return [...rows.dispatches.map((d) => dispatchItem(d, now)), ...rows.callbacks.map((c) => callbackItem(c, now))].sort(
    (a, b) => rank(a.urgency) - rank(b.urgency) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

export type BoardSummary = { open: number; overdue: number; safety: number; emergencies: number; coverage: number; callbacks: number };

/** The summary bar above the board. */
/** The summary bar above the board: counts over items that aren't resolved. */
export function boardSummary(items: BoardItem[]): BoardSummary {
  const open = items.filter((i) => i.stage !== "resolved");
  return {
    open: open.length,
    overdue: open.filter((i) => i.overdue).length,
    safety: open.filter((i) => i.urgency === "safety_stop").length,
    emergencies: open.filter((i) => i.urgency === "emergency").length,
    coverage: open.filter((i) => i.coverageCheck !== null).length,
    callbacks: open.filter((i) => i.kind === "callback").length,
  };
}

export type BoardTab = "open" | "called_back" | "resolved";
export type BoardKind = "all" | "safety" | "priority" | "callbacks" | "coverage";

/** The /dispatch tabs and quick filters (?tab=…&kind=…). Resolved items stay findable. */
export function filterBoard(items: BoardItem[], tab: BoardTab, kind: BoardKind = "all"): BoardItem[] {
  const stage: BoardStage = tab === "open" ? "new" : tab;
  return items.filter((i) => {
    if (i.stage !== stage) return false;
    if (kind === "safety") return i.urgency === "safety_stop";
    if (kind === "priority") return i.kind === "dispatch" && i.urgency === "emergency";
    if (kind === "callbacks") return i.kind === "callback";
    if (kind === "coverage") return i.coverageCheck !== null;
    return true;
  });
}

export type BoardGroup = { key: Urgency | "other"; label: string; items: BoardItem[] };

const GROUP_LABEL: Record<Urgency | "other", string> = {
  safety_stop: "Safety stops",
  emergency: "Emergencies",
  urgent: "Urgent",
  routine: "Routine",
  other: "Callbacks and follow-ups",
};

/** Board items in urgency groups (most urgent first), keeping the board's order inside each. */
export function groupBoard(items: BoardItem[]): BoardGroup[] {
  const order: Array<Urgency | "other"> = ["safety_stop", "emergency", "urgent", "routine", "other"];
  return order
    .map((key) => ({ key, label: GROUP_LABEL[key], items: items.filter((i) => (i.urgency ?? "other") === key) }))
    .filter((g) => g.items.length > 0);
}

export { slaCountdown, type SlaState } from "./sla";
