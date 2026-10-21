import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appointments, appointmentSlots, toolInvocations } from "@/server/db/schema";
import {
  cancelAppointmentAction,
  completeAppointment,
  markCalledBack,
  rescheduleAppointmentAction,
  resolveItem,
  undoAction,
  type ConsoleActionResult,
} from "@/server/console/actions";
import { buildBoard } from "@/server/console/board";
import { filterCalls, DEFAULT_FILTER } from "@/server/console/call-filters";
import { callTime, classifyTool, navCounts, todayMetrics, todayWindow, toolHealth } from "@/server/console/metrics";
import { createConsoleRepository } from "@/server/repositories/console";
import type { CallActivityRow } from "@/server/repositories";
import { rescheduleOptions } from "@/server/services/appointment-lifecycle";
import { isSimulationMessage, parseToolCallsEnvelope } from "@/server/vapi/envelope";
import { parseEndOfCallReport } from "@/server/vapi/events";
import { callTool as callToolAt, post, slotFactory, TEST_NOW, testDb, testDeps, testRepos, toolCallsBody } from "./helpers";

const makeSlot = slotFactory(11);
const TZ = "America/New_York";
const deps = (now = TEST_NOW) => ({ repos: testRepos(), now, timeZone: TZ });
const consoleRepo = () => createConsoleRepository(testDb());
const undoOf = (r: ConsoleActionResult) => {
  if (!r.ok || !r.undo) throw new Error(`expected an undo token, got ${JSON.stringify(r)}`);
  return r.undo;
};

async function booked(slotId: string) {
  const [row] = await testDb().select({ booked: appointmentSlots.booked }).from(appointmentSlots).where(eq(appointmentSlots.id, slotId));
  return row.booked;
}

async function stageOf(id: string) {
  const [row] = await consoleRepo().appointments({ includeSeed: true, includeTests: true, ids: [id], limit: 1 });
  return row;
}

/** A real booking through book_appointment, at TEST_NOW, into `slotId`. */
async function book(slotId: string, phone: string) {
  const { payload } = await callToolAt(
    "book_appointment",
    {
      slot_id: slotId,
      caller_confirmed: true,
      first_name: "Rory",
      last_name: "Lifecycle",
      phone,
      address: { line1: "12 Workflow Ave", city: "Brooklyn", zip: "11215" },
      service_type: "repair",
      urgency: "routine",
      issue_summary: "No cooling upstairs",
      symptoms: ["warm air"],
      vulnerable_occupants: [],
    },
    { deps: { now: () => TEST_NOW } },
  );
  expect(payload).toMatchObject({ ok: true, booked: true });
  return String(payload.appointment_id);
}

describe("dispatch lifecycle: New → Called back → Resolved, each undoable", () => {
  it("a callback moves through the stages, and undo puts it back exactly", async () => {
    const { id } = await testRepos().callbacks.create({ callerPhone: "+17185550411", callerName: "Undo Test", reason: "human_requested", context: {}, vapiCallId: `call-${randomUUID()}` });
    const stage = async () => {
      const rows = await consoleRepo().board({ includeSeed: false, includeTests: true, resolvedSince: new Date(0) });
      return buildBoard(rows, new Date()).find((i) => i.id === id)!;
    };
    expect((await stage()).stage).toBe("new");

    const called = await markCalledBack({ kind: "callback", id, by: "Jo" }, deps(new Date()));
    expect(await stage()).toMatchObject({ stage: "called_back", calledBackBy: "Jo", overdue: false });

    const resolved = await resolveItem({ kind: "callback", id, resolution: "No answer, will retry", note: "Voicemail", by: "Jo" }, deps(new Date()));
    expect(await stage()).toMatchObject({ stage: "resolved", resolution: "No answer, will retry", resolutionNote: "Voicemail", resolvedBy: "Jo" });

    // Undo the resolve: back to Called back (not New), outcome cleared.
    expect(await undoAction(undoOf(resolved), deps())).toMatchObject({ ok: true });
    expect(await stage()).toMatchObject({ stage: "called_back", resolution: null, resolvedAt: null });
    // Undo the call back: New again, SLA running.
    expect(await undoAction(undoOf(called), deps())).toMatchObject({ ok: true });
    expect(await stage()).toMatchObject({ stage: "new", calledBackAt: null, calledBackBy: null });
    // A stale token is harmless.
    expect(await undoAction(undoOf(called), deps())).toEqual({ ok: false, error: "Nothing to undo." });
  });

  it("a priority request resolved from New un-resolves back to New", async () => {
    const { id } = await testRepos().dispatch.create({
      customerId: null,
      callerPhone: "+17185550412",
      callerName: null,
      address: { zip: "11215" },
      urgency: "emergency",
      reasons: ["No heat"],
      intake: {},
      vapiCallId: `call-${randomUUID()}`,
    });
    const r = await resolveItem({ kind: "dispatch", id, resolution: "Technician dispatched", by: "Kim" }, deps(new Date()));
    expect(await undoAction(undoOf(r), deps())).toMatchObject({ ok: true });
    const rows = await consoleRepo().board({ includeSeed: false, includeTests: true });
    expect(rows.dispatches.find((d) => d.id === id)).toMatchObject({ status: "open", resolution: null, acknowledgedAt: null });
  });

  it("rejects forged undo tokens", async () => {
    expect(await undoAction({ op: "drop_table", id: randomUUID() }, deps())).toEqual({ ok: false, error: "Unknown request." });
    expect(await undoAction({ op: "unresolve", kind: "dispatch", id: "not-a-uuid" }, deps())).toEqual({ ok: false, error: "Unknown request." });
  });
});

describe("appointment lifecycle", () => {
  it("reschedule claims the new seat, frees the old one and keeps history; undo reverses both", async () => {
    const from = await makeSlot({ capacity: 2, booked: 0 });
    const to = await makeSlot({ capacity: 1, booked: 0 });
    const id = await book(from.id, "+17185550421");
    expect(await booked(from.id)).toBe(1);

    const r = await rescheduleAppointmentAction({ id, slotId: to.id, by: "Lee" }, deps());
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/^Rescheduled to /) });
    const newId = r.ok ? r.appointmentId! : "";
    expect(await booked(from.id)).toBe(0);
    expect(await booked(to.id)).toBe(1);
    expect(await stageOf(id)).toMatchObject({ stage: "cancelled", rescheduledTo: newId, statusBy: "Lee" });
    expect(await stageOf(newId)).toMatchObject({ stage: "scheduled", rescheduledFrom: id, slotId: to.id, issueSummary: "No cooling upstairs" });

    // The new window is now full: a second move into it is refused and changes nothing.
    const other = await book(from.id, "+17185550422");
    expect(await rescheduleAppointmentAction({ id: other, slotId: to.id }, deps())).toEqual({ ok: false, error: "That window was just taken. Pick another." });
    expect(await booked(from.id)).toBe(1);
    expect(await booked(to.id)).toBe(1);

    expect(await undoAction(undoOf(r), deps())).toMatchObject({ ok: true });
    expect(await booked(from.id)).toBe(2);
    expect(await booked(to.id)).toBe(0);
    expect(await stageOf(id)).toMatchObject({ stage: "scheduled", rescheduledTo: null });
    expect(await testDb().select().from(appointments).where(eq(appointments.id, newId))).toEqual([]);
  });

  it("won't reschedule to another borough or the same window", async () => {
    const from = await makeSlot({ capacity: 1, booked: 0 });
    const queens = await makeSlot({ capacity: 1, booked: 0, county: "Queens" });
    const id = await book(from.id, "+17185550423");
    expect(await rescheduleAppointmentAction({ id, slotId: queens.id }, deps())).toEqual({ ok: false, error: "That window is for a different borough." });
    expect(await rescheduleAppointmentAction({ id, slotId: from.id }, deps())).toEqual({ ok: false, error: "That's the current window." });
    expect(await booked(queens.id)).toBe(0);
  });

  it("the picker offers real open windows in the same borough, never the current one", async () => {
    const from = await makeSlot({ capacity: 1, booked: 0 });
    const id = await book(from.id, "+17185550424");
    const a = await stageOf(id);
    const options = await rescheduleOptions(a, { repos: testRepos(), now: TEST_NOW, timeZone: TZ });
    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.slotId)).not.toContain(from.id);
    const slots = await testDb().select().from(appointmentSlots);
    for (const o of options) {
      const s = slots.find((x) => x.id === o.slotId)!;
      expect(s.county).toBe("Kings");
      expect(s.booked).toBeLessThan(s.capacity);
    }
  });

  it("cancel frees the seat at once; undo re-claims it", async () => {
    const slot = await makeSlot({ capacity: 1, booked: 0 });
    const id = await book(slot.id, "+17185550425");
    const r = await cancelAppointmentAction({ id, by: "Ana" }, deps());
    expect(r).toMatchObject({ ok: true });
    expect(await booked(slot.id)).toBe(0);
    expect(await stageOf(id)).toMatchObject({ stage: "cancelled", statusBy: "Ana" });
    expect(await cancelAppointmentAction({ id }, deps())).toEqual({ ok: false, error: "It's no longer scheduled." });
    expect(await undoAction(undoOf(r), deps())).toMatchObject({ ok: true });
    expect(await booked(slot.id)).toBe(1);
    expect((await stageOf(id)).stage).toBe("scheduled");
  });

  it("completed and no-show keep the seat, record the note, and can be undone", async () => {
    const slot = await makeSlot({ capacity: 2, booked: 0 });
    const id = await book(slot.id, "+17185550426");
    const r = await completeAppointment({ id, outcome: "completed", note: "Replaced capacitor", by: "Max" }, deps());
    expect(await stageOf(id)).toMatchObject({ stage: "completed", completionNote: "Replaced capacitor", statusBy: "Max" });
    expect(await booked(slot.id)).toBe(1);
    // A closed visit can't be cancelled or rescheduled.
    expect(await cancelAppointmentAction({ id }, deps())).toMatchObject({ ok: false });
    expect(await undoAction(undoOf(r), deps())).toMatchObject({ ok: true });
    expect((await stageOf(id)).stage).toBe("scheduled");

    await completeAppointment({ id, outcome: "no_show" }, deps());
    expect((await stageOf(id)).stage).toBe("no_show");
  });
});

describe("metrics agree everywhere", () => {
  // 2026-10-21 in New York (EDT, UTC−4): local midnight is 04:00Z.
  const now = new Date("2026-10-21T18:00:00Z");
  const today = todayWindow(TZ, now);
  const row = (id: string, over: Partial<CallActivityRow>): CallActivityRow => ({
    vapiCallId: id,
    startedAt: null,
    endedAt: null,
    endedReason: null,
    callerPhone: null,
    summary: null,
    transcript: null,
    hasReport: false,
    firstActivityAt: null,
    lastActivityAt: null,
    isDemoSeed: false,
    ...over,
  }) as CallActivityRow;
  const calls = [
    row("yesterday-late", { startedAt: new Date("2026-10-21T03:59:00Z"), endedAt: new Date("2026-10-21T04:06:00Z"), hasReport: true }), // 11:59 PM → 12:06 AM
    row("midnight", { startedAt: new Date("2026-10-21T04:00:00Z"), endedAt: new Date("2026-10-21T04:03:00Z"), hasReport: true }),
    row("tools-only", { firstActivityAt: new Date("2026-10-21T15:00:00Z"), lastActivityAt: new Date("2026-10-21T15:01:00Z") }),
    row("report-no-start", { endedAt: new Date("2026-10-21T16:00:00Z"), hasReport: true }),
    row("two-days-ago", { startedAt: new Date("2026-10-19T15:00:00Z"), hasReport: true }),
  ];

  it("today's window is local midnight to midnight", () => {
    expect(today.from.toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(today.to.toISOString()).toBe("2026-10-22T04:00:00.000Z");
  });

  it("sidebar, Overview and the Calls page's Today filter count the same calls", () => {
    const sidebar = navCounts([], calls, today).callsToday;
    const overview = todayMetrics({
      calls: calls.map((c) => ({ at: callTime(c), outcome: "incomplete" as const, status: "ended" as const, responseP50Ms: null })),
      board: [],
      bookingsToday: 0,
      toolRows: [],
      window: today,
    }).calls;
    const callsPage = filterCalls(
      calls.map((c) => ({ vapiCallId: c.vapiCallId, at: callTime(c)?.toISOString() ?? null, callerName: null, callerPhone: null, issue: null, urgency: null, outcome: "incomplete" as const, status: "ended" as const })),
      { ...DEFAULT_FILTER, range: "today" },
      now.getTime(),
      today.from.getTime(),
    ).length;
    expect([sidebar, overview, callsPage]).toEqual([3, 3, 3]);
  });

  it("data that can't exist yet is null (shown as —), not zero", () => {
    const m = todayMetrics({ calls: [], board: [], bookingsToday: 0, toolRows: [], window: today });
    expect(m).toMatchObject({ calls: 0, handledWithoutStaffPct: null, medianResponseMs: null });
    expect(toolHealth([])).toEqual({ calls: 0, errors: 0, refusals: 0, p50Ms: null, p95Ms: null });
  });

  it("guardrail refusals are not errors", () => {
    expect(classifyTool(false, "slot_taken")).toBe("refusal");
    expect(classifyTool(false, "emergency_not_bookable")).toBe("refusal");
    expect(classifyTool(false, "internal_error")).toBe("error");
    expect(classifyTool(false, null)).toBe("error");
    expect(classifyTool(true, null)).toBe("ok");
    const h = toolHealth([
      { toolName: "book_appointment", ok: false, errorCode: "slot_taken", latencyMs: 40, createdAt: now },
      { toolName: "book_appointment", ok: false, errorCode: "internal_error", latencyMs: 90, createdAt: now },
      { toolName: "check_service_area", ok: true, errorCode: null, latencyMs: 20, createdAt: now },
    ]);
    expect(h).toMatchObject({ calls: 3, errors: 1, refusals: 1, p50Ms: 40, p95Ms: 90 });
  });

  it("the overview's priority count, open callbacks and the board summary come from the same items", () => {
    const board = buildBoard(
      {
        dispatches: [
          { id: randomUUID(), urgency: "emergency", reasons: [], status: "open", callerName: null, callerPhone: null, address: null, intake: null, customerName: null, customerPhone: null, createdAt: new Date("2026-10-21T17:55:00Z"), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolution: null, resolutionNote: null, resolvedBy: null, vapiCallId: "x", isDemoSeed: false },
          { id: randomUUID(), urgency: "emergency", reasons: [], status: "resolved", callerName: null, callerPhone: null, address: null, intake: null, customerName: null, customerPhone: null, createdAt: new Date("2026-10-21T13:00:00Z"), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: new Date("2026-10-21T13:20:00Z"), resolution: "Technician dispatched", resolutionNote: null, resolvedBy: null, vapiCallId: "y", isDemoSeed: false },
        ],
        callbacks: [],
      },
      now,
    );
    const m = todayMetrics({ calls: [], board, bookingsToday: 0, toolRows: [], window: today });
    expect(m.priorityRequests).toBe(2); // both were created today; one is already resolved
    expect(navCounts(board, [], today)).toMatchObject({ openBoard: 1, urgentOpen: 1 });
  });
});

describe("test runs (Vapi simulations, web calls) are classified and hidden by default", () => {
  it("classifies envelopes", () => {
    expect(isSimulationMessage({ call: { id: "c", type: "inboundPhoneCall" } })).toBe(false);
    expect(isSimulationMessage({ call: { id: "c", type: "outboundPhoneCall" } })).toBe(false);
    expect(isSimulationMessage({ call: { id: "c" } })).toBe(false); // sparse but real: never hide a caller
    expect(isSimulationMessage({ call: { id: "c", type: "webCall" } })).toBe(true);
    expect(isSimulationMessage({ call: { id: "c", type: "vapi.websocketCall" } })).toBe(true);
    expect(isSimulationMessage({ chat: { id: "chat-1" } })).toBe(true);
    expect(isSimulationMessage({})).toBe(true);
    expect(parseEndOfCallReport({ message: { type: "end-of-call-report", call: { id: "c", type: "webCall" } } })?.isSimulation).toBe(true);
    expect(parseEndOfCallReport({ message: { type: "end-of-call-report", call: { id: "c", type: "inboundPhoneCall" } } })?.isSimulation).toBe(false);
  });

  it("a web call's tool activity and its dispatch stay off the console unless Show test runs is on", async () => {
    const { handleToolsRequest } = await import("@/server/vapi/http");
    const callId = `call-${randomUUID()}`;
    const body = toolCallsBody({ callId, calls: [{ id: "t", name: "check_service_area", arguments: { zip: "11215" } }] });
    body.message.call.type = "webCall";
    expect(parseToolCallsEnvelope(body)?.isSimulation).toBe(true);
    await handleToolsRequest(post("/api/vapi/tools", body), testDeps());
    const [inv] = await testDb().select().from(toolInvocations).where(eq(toolInvocations.vapiCallId, callId));
    expect(inv.isSimulation).toBe(true);
    const { id: dispatchId } = await testRepos().dispatch.create({ customerId: null, callerPhone: null, callerName: null, address: null, urgency: "emergency", reasons: [], intake: {}, vapiCallId: callId });

    const hidden = { includeSeed: true, includeTests: false };
    const shown = { includeSeed: true, includeTests: true };
    expect((await consoleRepo().recentCalls({ ...hidden, limit: 2000 })).some((c) => c.vapiCallId === callId)).toBe(false);
    const visible = (await consoleRepo().recentCalls({ ...shown, limit: 2000 })).find((c) => c.vapiCallId === callId);
    expect(visible).toMatchObject({ isSimulation: true });
    expect((await consoleRepo().board(hidden)).dispatches.some((d) => d.id === dispatchId)).toBe(false);
    expect((await consoleRepo().board(shown)).dispatches.some((d) => d.id === dispatchId)).toBe(true);
    const from = new Date(Date.now() - 60_000);
    expect((await consoleRepo().toolHealthRows({ ...hidden, from })).length).toBeLessThan((await consoleRepo().toolHealthRows({ ...shown, from })).length);

    // A real phone call is never hidden.
    const real = `call-${randomUUID()}`;
    await callToolAt("check_service_area", { zip: "11215" }, { callId: real });
    expect((await consoleRepo().recentCalls({ ...hidden, limit: 2000 })).some((c) => c.vapiCallId === real)).toBe(true);
  });
});
