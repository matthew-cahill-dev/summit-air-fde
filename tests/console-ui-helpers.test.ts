// Pure helpers behind the operations console UI: call steps, transcript interleaving, board
// summary and SLA countdown, overview charts, call filters, header titles.
import { describe, expect, it } from "vitest";
import { titleForPath } from "@/components/console/nav";
import { OUTCOME_TONE, TONE_BADGE, URGENCY_TONE } from "@/components/console/tone";
import { boardSummary, groupBoard, slaCountdown, type BoardItem } from "@/server/console/board";
import { filterCalls, DEFAULT_FILTER, type CallRowLite } from "@/server/console/call-filters";
import { dayDelta, outcomeBreakdown, sparkPath } from "@/server/console/charts";
import { CALL_OUTCOMES } from "@/server/console/outcome";
import { buildSteps, describeInvocation, interleave, parseTranscript, shortWindow, stepChips } from "@/server/console/steps";
import type { InvocationRow } from "@/server/repositories";

const inv = (toolName: string, result: Record<string, unknown>, args: Record<string, unknown> | null = {}, ok = true): InvocationRow =>
  ({ id: `${toolName}-${Math.random()}`, vapiCallId: "c", toolName, ok, args, result, latencyMs: 40, dbMs: 12, createdAt: new Date("2026-10-21T14:00:00Z") }) as InvocationRow;

describe("call steps in plain language", () => {
  it("lookup, triage, booking, dispatch, coverage and safety read like an operator would say them", () => {
    expect(describeInvocation(inv("lookup_customer", { verified: true, is_member: true, first_name: "Priya" }))).toMatchObject({
      title: "Verified returning member",
      detail: "Priya · active Comfort Club member",
      tone: "booked",
    });
    expect(describeInvocation(inv("lookup_customer", { found: false, verified: false })).title).toBe("New caller");
    expect(
      describeInvocation(inv("triage_issue", { urgency: "urgent", next_action: "book_earliest", offered_slots: [{}, {}, {}] }, { vulnerable_occupants: ["elderly"] })),
    ).toMatchObject({ title: "Triaged: urgent · elderly occupant", detail: "Offered 3 windows", tone: "urgent" });
    expect(describeInvocation(inv("triage_issue", { urgency: "safety_stop", next_action: "safety_instructions" }, { gas_smell: true }))).toMatchObject({
      title: "Safety stop: gas smell",
      tone: "safety",
    });
    expect(describeInvocation(inv("triage_issue", { coverage_check: true, borough: "Staten Island", next_action: "office_review" }))).toMatchObject({
      title: "Office coverage check · Staten Island",
      tone: "coverage",
    });
    expect(describeInvocation(inv("book_appointment", { booked: true, window: "tomorrow, Thursday, October 22, between 8 and 10 AM", confirmation_code: "SA-1A2B3C" }))).toMatchObject({
      title: "Booked Thu Oct 22, 8–10 AM",
      detail: "Confirmation SA-1A2B3C",
      tone: "booked",
    });
    expect(describeInvocation(inv("create_priority_dispatch", { callback_sla_minutes: 15 }))).toMatchObject({ title: "Priority dispatch logged", tone: "emergency" });
    expect(describeInvocation(inv("create_callback_request", {}, { reason: "other", details: "coverage check: Bronx, 10463" }))).toMatchObject({
      title: "Office coverage check · Bronx",
      tone: "coverage",
    });
    expect(describeInvocation(inv("triage_issue", { error_code: "lookup_required" }, {}, false)).title).toBe("Waited for the account lookup");
  });

  it("shortWindow, chips (no ids or false flags) and step metadata", () => {
    expect(shortWindow("today, Wednesday, October 21, between 1 and 5 PM")).toBe("Wed Oct 21, 1–5 PM");
    expect(shortWindow("something else")).toBe("something else");
    expect(stepChips({ customer_id: "x", gas_smell: false, issue_type: "no_heat", vulnerable_occupants: ["medical_condition"], address: { line1: "1 Main", zip: "11215" } })).toEqual([
      ["issue type", "no heat"],
      ["vulnerable occupants", "medical condition"],
      ["address", "1 Main, 11215"],
    ]);
    const [step] = buildSteps([inv("lookup_customer", { verified: true })]);
    expect(step).toMatchObject({ latencyMs: 40, dbMs: 12, ok: true, icon: "user" });
  });

  it("interleaves transcript lines and steps by time; a step sits after the line that triggered it", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 21, 14, 0, s));
    const steps = buildSteps([{ ...inv("triage_issue", { urgency: "routine" }), createdAt: t(5) }]);
    const items = interleave(
      [
        { role: "caller", text: "My AC is out", at: t(1) },
        { role: "ava", text: "One moment", at: t(5) },
        { role: "ava", text: "I can offer…", at: t(8) },
      ],
      steps,
    );
    expect(items.map((i) => (i.kind === "message" ? i.message.text : `[${i.step.tool}]`))).toEqual(["My AC is out", "One moment", "[triage_issue]", "I can offer…"]);
    expect(parseTranscript("AI: Hi there\nUser: Hello\nnoise")).toEqual([
      { role: "ava", text: "Hi there" },
      { role: "caller", text: "Hello" },
      { role: null, text: "noise" },
    ]);
  });
});

describe("dispatch board", () => {
  const item = (over: Partial<BoardItem>): BoardItem =>
    ({ kind: "dispatch", id: Math.random().toString(), urgency: null, overdue: false, coverageCheck: null, ...over }) as BoardItem;

  it("summary counts and urgency groups (most urgent first)", () => {
    const items = [
      item({ urgency: "safety_stop", overdue: true }),
      item({ urgency: "emergency" }),
      item({ kind: "callback", urgency: "urgent", coverageCheck: "Bronx" }),
      item({ kind: "callback" }),
    ];
    expect(boardSummary(items)).toEqual({ open: 4, overdue: 1, safety: 1, emergencies: 1, coverage: 1, callbacks: 2 });
    expect(groupBoard(items).map((g) => [g.key, g.items.length])).toEqual([
      ["safety_stop", 1],
      ["emergency", 1],
      ["urgent", 1],
      ["other", 1],
    ]);
  });

  it("SLA countdown: due in mm:ss → overdue mm:ss; acknowledged shows how long ago", () => {
    const created = Date.UTC(2026, 9, 21, 14, 0, 0);
    expect(slaCountdown(created, 15, created + 3 * 60_000 + 18_000)).toMatchObject({ label: "Callback due in 11:42", overdue: false });
    expect(slaCountdown(created, 15, created + 18 * 60_000 + 10_000)).toMatchObject({ label: "Overdue 3:10", overdue: true, used: 1 });
    expect(slaCountdown(created, 120, created + 4 * 3_600_000).label).toBe("Overdue 2:00:00");
    expect(slaCountdown(created, 15, created + 5 * 60_000, created + 2 * 60_000).label).toBe("Acknowledged 3:00 ago");
  });
});

describe("overview charts", () => {
  it("sparkline paths scale to the box and skip missing days", () => {
    expect(sparkPath([], 96, 28)).toBe("");
    expect(sparkPath([1, 3, 2], 100, 20, 0)).toBe("M0.0,20.0 L50.0,0.0 L100.0,10.0");
    expect(sparkPath([null, 5, null], 100, 20, 0)).toBe("M50.0,10.0");
  });

  it("day-over-day deltas", () => {
    expect(dayDelta(9, 1)).toEqual({ text: "+8 vs yesterday", direction: "up" });
    expect(dayDelta(2, 3)).toEqual({ text: "−1 vs yesterday", direction: "down" });
    expect(dayDelta(4, 4)).toEqual({ text: "same as yesterday", direction: "flat" });
    expect(dayDelta(1200, 1500, "percent")).toEqual({ text: "−20% vs yesterday", direction: "down" });
    expect(dayDelta(null, 3)).toBeNull();
  });

  it("outcome mix: every outcome, percentages add to 100", () => {
    const mix = outcomeBreakdown(["booked", "booked", "callback", "safety_stop", "incomplete", "booked", "coverage_check"]);
    expect(mix.map((m) => m.outcome)).toEqual([...CALL_OUTCOMES]);
    expect(mix.reduce((s, m) => s + m.percent, 0)).toBe(100);
    expect(mix.find((m) => m.outcome === "booked")).toMatchObject({ count: 3, percent: 43 });
    expect(outcomeBreakdown([]).every((m) => m.percent === 0)).toBe(true);
  });
});

describe("calls list filters", () => {
  const now = Date.UTC(2026, 9, 21, 18, 0);
  const todayStart = Date.UTC(2026, 9, 21, 4, 0);
  const row = (over: Partial<CallRowLite>): CallRowLite => ({
    vapiCallId: Math.random().toString(),
    at: new Date(now - 3_600_000).toISOString(),
    callerName: null,
    callerPhone: null,
    issue: null,
    urgency: null,
    outcome: "booked",
    status: "ended",
    ...over,
  });

  it("filters by outcome, urgency and range; searches name or phone digits; pins live calls", () => {
    const priya = row({ callerName: "Priya Marlowe-Venn", callerPhone: "+13475550102", urgency: "urgent" });
    const old = row({ at: new Date(now - 10 * 86_400_000).toISOString(), outcome: "callback" });
    const live = row({ status: "in_progress", outcome: "incomplete" });
    const yesterday = row({ at: new Date(todayStart - 3_600_000).toISOString(), urgency: "safety_stop", outcome: "safety_stop" });
    const rows = [priya, old, yesterday, live];
    expect(filterCalls(rows, DEFAULT_FILTER, now, todayStart)[0]).toBe(live);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, outcome: "callback" }, now, todayStart)).toEqual([old]);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, urgency: "safety_stop" }, now, todayStart)).toEqual([yesterday]);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, range: "today" }, now, todayStart)).toEqual([live, priya]);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, range: "7d" }, now, todayStart)).toHaveLength(3);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, q: "marlowe" }, now, todayStart)).toEqual([priya]);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, q: "(347) 555-0102" }, now, todayStart)).toEqual([priya]);
    expect(filterCalls(rows, { ...DEFAULT_FILTER, q: "55" }, now, todayStart)).toEqual([]); // too few digits to match a phone
  });
});

describe("shell and semantic colors", () => {
  it("header titles come from the path", () => {
    expect(titleForPath("/dispatch")).toBe("Dispatch");
    expect(titleForPath("/calls")).toBe("Calls");
    expect(titleForPath("/calls/abc-123")).toBe("Call");
    expect(titleForPath("/overview")).toBe("Overview");
    expect(titleForPath(null)).toBe("");
  });

  it("one color per meaning, used everywhere", () => {
    expect(URGENCY_TONE).toEqual({ safety_stop: "safety", emergency: "emergency", urgent: "urgent", routine: "routine" });
    expect(OUTCOME_TONE).toMatchObject({ safety_stop: "safety", priority_dispatch: "emergency", booked: "booked", coverage_check: "coverage", callback: "callback", not_serviceable: "neutral", incomplete: "neutral" });
    expect(TONE_BADGE.coverage).toContain("coverage");
    expect(TONE_BADGE.callback).toContain("callback");
  });
});
