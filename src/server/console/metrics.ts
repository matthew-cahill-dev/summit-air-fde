// Every number the console shows, defined once. The sidebar, Overview, Calls and Dispatch all
// count from these functions over the same rows, so they always agree. Pure; time windows are
// local days in the console's time zone (America/New_York).
//
// Definitions:
//   call            any vapi_call_id with an end-of-call report OR tool activity (test traffic and
//                   seed data are excluded upstream by the repository Scope)
//   call time       when it started, else its first tool call, else when it ended
//   booking         an appointment created in the window that isn't a reschedule of another
//   priority request a priority (emergency) dispatch created in the window
//   handled without staff  calls whose outcome needed no office follow-up (booked, or explained and
//                   closed as not serviceable), out of today's finished calls with a known outcome
//   tool error      a tool call that failed for a real reason (a crash, an unknown tool)
//   guardrail refusal  a tool call the backend refused on purpose (missing details, lookup first,
//                   window taken, emergency not bookable, coverage check, out of area, …)
import { addDays, localInfo, todayInZone, zonedTimeToUtc } from "@/server/lib/time";
import type { CallActivityRow, ToolHealthRow } from "@/server/repositories";
import type { BoardItem } from "./board";
import type { CallOutcome, CallStatus } from "./outcome";

export type Window = { from: Date; to: Date };

/** Today, local midnight to midnight, in `tz`. */
export function todayWindow(tz: string, now: Date): Window {
  const today = todayInZone(tz, now);
  return { from: zonedTimeToUtc(today, 0, 0, tz), to: zonedTimeToUtc(addDays(today, 1), 0, 0, tz) };
}

export function lastDaysWindow(tz: string, now: Date, days: number): Window {
  const today = todayInZone(tz, now);
  return { from: zonedTimeToUtc(addDays(today, -(days - 1)), 0, 0, tz), to: zonedTimeToUtc(addDays(today, 1), 0, 0, tz) };
}

export const inWindow = (at: Date | null | undefined, w: Window) => Boolean(at && at >= w.from && at < w.to);

/** A call's time: when it started, else its first tool call, else when it ended. */
export function callTime(c: Pick<CallActivityRow, "startedAt" | "firstActivityAt" | "endedAt">): Date | null {
  return c.startedAt ?? c.firstActivityAt ?? c.endedAt;
}

export function countCalls(calls: Array<Pick<CallActivityRow, "startedAt" | "firstActivityAt" | "endedAt">>, w: Window): number {
  return calls.filter((c) => inWindow(callTime(c), w)).length;
}

// --- Tool health ------------------------------------------------------------------------

/** Deliberate refusals by the backend's guardrails: the agent is told what to do next. Not failures. */
export const GUARDRAIL_CODES = [
  "invalid_arguments",
  "lookup_required",
  "slot_taken",
  "slot_wrong_area",
  "slot_not_found",
  "emergency_not_bookable",
  "coverage_check",
  "out_of_area",
  "residential_only",
  "customer_not_found",
  "address_not_found",
] as const;

export type ToolClass = "ok" | "refusal" | "error";

export function classifyTool(ok: boolean, errorCode: string | null): ToolClass {
  if (ok) return "ok";
  return errorCode && (GUARDRAIL_CODES as readonly string[]).includes(errorCode) ? "refusal" : "error";
}

export type ToolHealth = { calls: number; errors: number; refusals: number; p50Ms: number | null; p95Ms: number | null };

const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

export function toolHealth(rows: ToolHealthRow[]): ToolHealth {
  const classes = rows.map((r) => classifyTool(r.ok, r.errorCode));
  const latencies = rows.map((r) => r.latencyMs);
  return {
    calls: rows.length,
    errors: classes.filter((c) => c === "error").length,
    refusals: classes.filter((c) => c === "refusal").length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

// --- Today ------------------------------------------------------------------------------

export type CallForMetrics = { at: Date | null; outcome: CallOutcome; status: CallStatus; responseP50Ms: number | null };

/** Calls whose outcome needed no office follow-up. */
export const HANDLED_WITHOUT_STAFF: CallOutcome[] = ["booked", "not_serviceable"];

export type TodayMetrics = {
  calls: number;
  bookings: number;
  priorityRequests: number;
  safetyStops: number;
  callbacksPending: number;
  callbacksRequested: number;
  transfers: number;
  /** 0–100, or null when no call finished with a known outcome today. */
  handledWithoutStaffPct: number | null;
  /** Median of today's per-call medians, or null when no call measured one (e.g. no voice calls). */
  medianResponseMs: number | null;
  respondedCalls: number;
};

export function todayMetrics(input: {
  calls: CallForMetrics[];
  board: BoardItem[];
  bookingsToday: number;
  toolRows: ToolHealthRow[];
  window: Window;
}): TodayMetrics {
  const calls = input.calls.filter((c) => inWindow(c.at, input.window));
  const finished = calls.filter((c) => c.status !== "in_progress" && c.outcome !== "incomplete");
  const responses = calls.map((c) => c.responseP50Ms).filter((v): v is number => v !== null);
  const createdToday = input.board.filter((i) => inWindow(i.createdAt, input.window));
  return {
    calls: calls.length,
    bookings: input.bookingsToday,
    priorityRequests: createdToday.filter((i) => i.kind === "dispatch" && i.urgency === "emergency").length,
    safetyStops: createdToday.filter((i) => i.kind === "dispatch" && i.urgency === "safety_stop").length,
    callbacksPending: input.board.filter((i) => i.kind === "callback" && i.stage !== "resolved").length,
    callbacksRequested: createdToday.filter((i) => i.kind === "callback").length,
    transfers: input.toolRows.filter((r) => r.toolName === "transfer_to_on_call" && r.ok && inWindow(r.createdAt, input.window)).length,
    handledWithoutStaffPct: finished.length ? Math.round((finished.filter((c) => HANDLED_WITHOUT_STAFF.includes(c.outcome)).length / finished.length) * 100) : null,
    medianResponseMs: percentile(responses, 50),
    respondedCalls: responses.length,
  };
}

/** What needs a person right now: open safety stops, emergencies not yet called back, overdue items. */
export function needsAttention(board: BoardItem[]): BoardItem[] {
  return board.filter(
    (i) => i.stage === "new" && (i.urgency === "safety_stop" || i.urgency === "emergency" || i.overdue),
  );
}

/** Sidebar badges, from the same board items and call rows as the pages. */
export function navCounts(board: BoardItem[], calls: Array<Pick<CallActivityRow, "startedAt" | "firstActivityAt" | "endedAt">>, today: Window) {
  const open = board.filter((i) => i.stage !== "resolved");
  return {
    openBoard: open.length,
    urgentOpen: open.filter((i) => i.stage === "new" && (i.urgency === "safety_stop" || i.urgency === "emergency" || i.overdue)).length,
    callsToday: countCalls(calls, today),
  };
}

/** Calls per local hour today, 0–23. */
export function callsByHour(calls: Array<{ at: Date | null }>, tz: string, w: Window): number[] {
  const out = Array.from({ length: 24 }, () => 0);
  for (const c of calls) if (c.at && inWindow(c.at, w)) out[localInfo(c.at, tz).hour]++;
  return out;
}
