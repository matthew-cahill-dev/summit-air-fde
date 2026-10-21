import { describe, expect, it } from "vitest";
import { dispatchItem } from "@/server/console/board";
import { safetyTriggerLabel } from "@/server/console/format";
import {
  deriveCallStatus,
  deriveOutcome,
  IN_PROGRESS_QUIET_MS,
  keyArgs,
  summarizeCall,
  type CallOutcome,
} from "@/server/console/outcome";
import type { CallActivityRow, CallRecords, InvocationRow } from "@/server/repositories";

const NOW = new Date("2026-10-20T15:00:00Z");
type Evidence = Parameters<typeof deriveOutcome>[0];

const inv = (toolName: string, result: Record<string, unknown> = {}, ok = true) => ({ toolName, ok, result: { ok, ...result } });
const none: Evidence = { invocations: [], appointments: [], dispatches: [], callbacks: [] };
const evidence = (over: Partial<Evidence>): Evidence => ({ ...none, ...over });

describe("deriveOutcome", () => {
  const cases: Array<[CallOutcome, string, Evidence]> = [
    ["booked", "a confirmed appointment", evidence({ appointments: [{ status: "confirmed" }] })],
    ["booked", "a successful book_appointment (record not linked)", evidence({ invocations: [inv("book_appointment", { booked: true })] })],
    ["priority_dispatch", "an emergency dispatch row", evidence({ dispatches: [{ urgency: "emergency" }] })],
    ["priority_dispatch", "a successful create_priority_dispatch", evidence({ invocations: [inv("create_priority_dispatch", { dispatch_id: "d" })] })],
    ["safety_stop", "a safety_stop dispatch row", evidence({ dispatches: [{ urgency: "safety_stop" }] })],
    [
      "safety_stop",
      "safety triage whose dispatch row failed to save",
      evidence({ invocations: [inv("triage_issue", { urgency: "safety_stop", next_action: "safety_instructions", office_followup_recorded: false })] }),
    ],
    ["callback", "a callback row", evidence({ callbacks: [{ status: "open" }] })],
    ["callback", "a successful create_callback_request", evidence({ invocations: [inv("create_callback_request", { callback_id: "c" })] })],
    [
      "not_serviceable",
      "triage explain_and_close (out of area)",
      evidence({ invocations: [inv("triage_issue", { urgency: "routine", serviceable: false, next_action: "explain_and_close" })] }),
    ],
    ["not_serviceable", "check_service_area commercial", evidence({ invocations: [inv("check_service_area", { serviceable: false, reason: "residential_only" })] })],
    ["incomplete", "no tool calls at all", none],
    [
      "incomplete",
      "only lookups and an offered slot, no booking",
      evidence({ invocations: [inv("lookup_customer", { verified: true }), inv("triage_issue", { urgency: "routine", next_action: "book_standard" })] }),
    ],
    [
      "incomplete",
      "failed tool calls don't count as outcomes",
      evidence({
        invocations: [
          inv("book_appointment", { error_code: "slot_taken" }, false),
          inv("create_callback_request", { error_code: "internal_error" }, false),
        ],
      }),
    ],
  ];

  it.each(cases)("%s from %s", (expected, _label, e) => {
    expect(deriveOutcome(e)).toBe(expected);
  });

  it("ranks safety stop > booked > priority dispatch > callback > not serviceable", () => {
    const all = evidence({
      dispatches: [{ urgency: "safety_stop" }, { urgency: "emergency" }],
      appointments: [{ status: "confirmed" }],
      callbacks: [{ status: "open" }],
      invocations: [inv("check_service_area", { serviceable: false })],
    });
    expect(deriveOutcome(all)).toBe("safety_stop");
    expect(deriveOutcome({ ...all, dispatches: [{ urgency: "emergency" }] })).toBe("booked");
    expect(deriveOutcome({ ...all, dispatches: [{ urgency: "emergency" }], appointments: [] })).toBe("priority_dispatch");
    expect(deriveOutcome({ ...all, dispatches: [], appointments: [] })).toBe("callback");
    // An out-of-area caller who also asked for a callback is a callback, not a dead end.
    expect(deriveOutcome({ ...all, dispatches: [], appointments: [], callbacks: [] })).toBe("not_serviceable");
  });

  it("a cancelled appointment alone isn't a booking", () => {
    expect(deriveOutcome(evidence({ appointments: [{ status: "cancelled" }] }))).toBe("incomplete");
  });
});

describe("deriveCallStatus", () => {
  const recent = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - IN_PROGRESS_QUIET_MS - 1);

  it("is in progress with tool activity and no end-of-call report", () => {
    expect(deriveCallStatus({ hasReport: false, lastActivityAt: recent }, 2, NOW)).toBe("in_progress");
  });

  it("a seed call is never in progress, even with fresh tool activity and no report", () => {
    expect(deriveCallStatus({ hasReport: false, lastActivityAt: recent, isDemoSeed: true }, 2, NOW)).toBe("ended");
    expect(deriveCallStatus({ hasReport: false, lastActivityAt: stale, isDemoSeed: true }, 2, NOW)).toBe("ended");
  });
  it("is ended once the report arrives", () => {
    expect(deriveCallStatus({ hasReport: true, lastActivityAt: recent }, 2, NOW)).toBe("ended");
  });
  it("flags a missing report after the call has been quiet past Vapi's max duration", () => {
    expect(deriveCallStatus({ hasReport: false, lastActivityAt: stale }, 2, NOW)).toBe("report_missing");
  });
});

describe("summarizeCall", () => {
  const call: CallActivityRow = {
    vapiCallId: "c1",
    startedAt: null,
    endedAt: null,
    endedReason: null,
    callerPhone: null,
    summary: null,
    hasReport: false,
    firstActivityAt: new Date(NOW.getTime() - 90_000),
    lastActivityAt: new Date(NOW.getTime() - 30_000),
    isDemoSeed: false,
  };
  const row = (toolName: string, args: Record<string, unknown>, result: Record<string, unknown>, ok = true): InvocationRow => ({
    id: `${toolName}-${Math.random()}`,
    vapiCallId: "c1",
    toolName,
    args,
    result: { ok, ...result },
    ok,
    latencyMs: 80,
    dbMs: 30,
    createdAt: NOW,
  });

  it("derives caller, issue, urgency and reasons for an in-progress priority call, ignoring other calls' rows", () => {
    const records: CallRecords = {
      invocations: [
        row("triage_issue", { issue_type: "no_heat" }, { urgency: "emergency", reasons: ["No heat with vulnerable occupants: elderly"] }),
        row("create_priority_dispatch", {}, { dispatch_id: "d1" }),
        { ...row("book_appointment", {}, { booked: true }), vapiCallId: "other-call" },
      ],
      appointments: [],
      dispatches: [
        {
          id: "d1",
          vapiCallId: "c1",
          urgency: "emergency",
          reasons: ["No heat with vulnerable occupants: elderly"],
          status: "open",
          callerName: "Hector Alvarenga-Stout",
          callerPhone: "+13475550110",
          intake: { issue_summary: "Boiler stopped" },
        },
      ],
      callbacks: [],
    };
    expect(summarizeCall(call, records, NOW)).toMatchObject({
      callerName: "Hector Alvarenga-Stout",
      callerPhone: "+13475550110",
      issue: "Boiler stopped",
      urgency: "emergency",
      reasons: ["No heat with vulnerable occupants: elderly"],
      outcome: "priority_dispatch",
      status: "in_progress",
      toolCount: 2,
      toolErrors: 0,
      at: call.firstActivityAt,
    });
  });

  it("falls back to the triaged issue type when nothing else describes the issue", () => {
    const records: CallRecords = {
      invocations: [row("triage_issue", { issue_type: "no_cooling" }, { urgency: "routine", next_action: "explain_and_close", serviceable: false }), row("lookup_customer", { phone: "x" }, { error_code: "invalid_arguments" }, false)],
      appointments: [],
      dispatches: [],
      callbacks: [],
    };
    expect(summarizeCall({ ...call, hasReport: true }, records, NOW)).toMatchObject({
      issue: "No cooling",
      urgency: "routine",
      outcome: "not_serviceable",
      status: "ended",
      toolErrors: 1,
    });
  });
});

describe("keyArgs", () => {
  it("keeps the informative scalar args for the timeline", () => {
    expect(
      keyArgs({
        issue_type: "no_heat",
        gas_smell: false,
        vulnerable_occupants: ["elderly", "infant"],
        indoor_temp_f: 58,
        notes: "",
        address: { line1: "88 Rockrose Ave", zip: "10314", unit: null },
      }),
    ).toEqual([
      ["issue_type", "no_heat"],
      ["vulnerable_occupants", "elderly, infant"],
      ["indoor_temp_f", "58"],
      ["address", "88 Rockrose Ave, 10314"],
    ]);
    expect(keyArgs(null)).toEqual([]);
  });
});

describe("safety stops are labeled by their trigger, never 'Other'", () => {
  it("safetyTriggerLabel reads triage args, intake.flags or reason strings", () => {
    expect(safetyTriggerLabel({ issue_type: "other", gas_smell: true, co_alarm: false })).toBe("Gas smell");
    expect(safetyTriggerLabel({ source: "triage_issue", flags: { co_alarm: true } })).toBe("CO alarm");
    expect(safetyTriggerLabel(["Burning smell or smoke reported"])).toBe("Smoke / burning smell");
    expect(safetyTriggerLabel({ gas_smell: true }, ["Carbon monoxide alarm reported"])).toBe("Gas smell + CO alarm");
    expect(safetyTriggerLabel({ issue_type: "no_heat" }, ["No heat during heat season"])).toBeNull();
  });

  it("calls list: the trigger replaces the issue type for a safety stop", () => {
    const call = { vapiCallId: "c1", startedAt: NOW, endedAt: NOW, endedReason: null, callerPhone: null, summary: null, hasReport: true, firstActivityAt: NOW, lastActivityAt: NOW, isDemoSeed: false };
    const records = {
      invocations: [
        {
          id: "i1",
          vapiCallId: "c1",
          toolName: "triage_issue",
          args: { issue_type: "other", gas_smell: false, co_alarm: false, burning_smell_or_smoke: true },
          result: { ok: true, urgency: "safety_stop", reasons: ["Burning smell or smoke reported"], next_action: "safety_instructions" },
          ok: true,
          latencyMs: 40,
          dbMs: 10,
          createdAt: NOW,
        },
      ],
      appointments: [],
      dispatches: [],
      callbacks: [],
    };
    expect(summarizeCall(call, records, NOW)).toMatchObject({ urgency: "safety_stop", issue: "Smoke / burning smell" });
  });

  it("board: a safety-stop dispatch shows its trigger", () => {
    const item = dispatchItem(
      {
        id: "d1",
        urgency: "safety_stop",
        reasons: ["Carbon monoxide alarm reported"],
        status: "open",
        callerName: null,
        callerPhone: "+17185550142",
        address: { zip: "11218" },
        intake: { source: "triage_issue", flags: { issue_type: "other", co_alarm: true } },
        customerName: null,
        customerPhone: null,
        createdAt: NOW,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolution: null,
        resolutionNote: null,
        resolvedBy: null,
        vapiCallId: null,
        isDemoSeed: false,
      },
      NOW,
    );
    expect(item.issue).toBe("CO alarm");
  });
});
