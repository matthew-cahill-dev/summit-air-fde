import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BUSINESS } from "@/config/business";
import { callbackRequests, dispatchRequests } from "@/server/db/schema";
import { acknowledgeDispatch, completeCallback, resolveDispatch } from "@/server/console/actions";
import { buildBoard } from "@/server/console/board";
import { summarizeCall } from "@/server/console/outcome";
import { createConsoleRepository } from "@/server/repositories/console";
import type { BoardCallbackRow, BoardDispatchRow, Repositories } from "@/server/repositories";
import { callTool, testDb, testRepos } from "./helpers";

const MIN = 60_000;

async function newDispatch(urgency: "emergency" | "safety_stop" = "emergency") {
  return testRepos().dispatch.create({
    customerId: null,
    callerPhone: "+17185550177",
    callerName: "Test Caller",
    address: { line1: "1 Test St", zip: "11215" },
    urgency,
    reasons: ["No heat with indoor temperature 50°F (at or below 55°F)"],
    intake: { issue_type: "no_heat" },
    vapiCallId: `call-${randomUUID()}`,
  });
}

async function newCallback() {
  return testRepos().callbacks.create({
    callerPhone: "+17185550177",
    callerName: "Test Caller",
    reason: "human_requested",
    context: { details: "Wants a person" },
    vapiCallId: `call-${randomUUID()}`,
  });
}

const dispatchRow = async (id: string) => (await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.id, id)))[0];

describe("dispatch actions", () => {
  it("acknowledge then resolve, recording when each happened; repeats are reported, not re-applied", async () => {
    const { id } = await newDispatch();
    const ackAt = new Date("2026-10-20T15:01:00Z");
    const resolvedAt = new Date("2026-10-20T15:20:00Z");
    const deps = (now: Date) => ({ repos: testRepos(), now });

    expect(await acknowledgeDispatch(id, deps(ackAt))).toEqual({ ok: true, status: "acknowledged" });
    expect(await dispatchRow(id)).toMatchObject({ status: "acknowledged", acknowledgedAt: ackAt, resolvedAt: null });
    expect(await acknowledgeDispatch(id, deps(resolvedAt))).toEqual({ ok: false, error: "Already acknowledged or resolved." });

    expect(await resolveDispatch(id, deps(resolvedAt))).toEqual({ ok: true, status: "resolved" });
    expect(await dispatchRow(id)).toMatchObject({ status: "resolved", acknowledgedAt: ackAt, resolvedAt });
    expect(await resolveDispatch(id, deps(new Date()))).toEqual({ ok: false, error: "Already resolved." });
    // Resolved can't go back to acknowledged.
    expect(await acknowledgeDispatch(id, deps(new Date()))).toMatchObject({ ok: false });
    expect((await dispatchRow(id)).status).toBe("resolved");
  });

  it("resolves straight from open", async () => {
    const { id } = await newDispatch("safety_stop");
    expect(await resolveDispatch(id, { repos: testRepos() })).toEqual({ ok: true, status: "resolved" });
    expect((await dispatchRow(id)).acknowledgedAt).toBeNull();
  });

  it("concurrent clicks apply exactly once", async () => {
    const { id } = await newDispatch();
    const results = await Promise.all([1, 2, 3].map(() => acknowledgeDispatch(id, { repos: testRepos() })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("rejects ids that aren't UUIDs or don't exist", async () => {
    expect(await acknowledgeDispatch("'; drop table dispatch_requests; --", { repos: testRepos() })).toEqual({ ok: false, error: "Unknown request." });
    expect(await resolveDispatch(undefined, { repos: testRepos() })).toEqual({ ok: false, error: "Unknown request." });
    expect(await resolveDispatch(randomUUID(), { repos: testRepos() })).toEqual({ ok: false, error: "Already resolved." });
  });

  it("turns a database failure into a retryable error", async () => {
    const broken = {
      ...testRepos(),
      dispatch: { ...testRepos().dispatch, acknowledge: () => Promise.reject(new Error("connection terminated")) },
    } satisfies Repositories;
    expect(await acknowledgeDispatch(randomUUID(), { repos: broken })).toEqual({ ok: false, error: "Couldn't save that. Try again." });
  });
});

describe("callback actions", () => {
  it("mark done once, with a completion time", async () => {
    const { id } = await newCallback();
    const at = new Date("2026-10-20T16:00:00Z");
    expect(await completeCallback(id, { repos: testRepos(), now: at })).toEqual({ ok: true, status: "done" });
    const [row] = await testDb().select().from(callbackRequests).where(eq(callbackRequests.id, id));
    expect(row).toMatchObject({ status: "done", completedAt: at });
    expect(await completeCallback(id, { repos: testRepos() })).toEqual({ ok: false, error: "Already marked done." });
    expect(await completeCallback("nope", { repos: testRepos() })).toEqual({ ok: false, error: "Unknown request." });
  });
});

describe("priority board", () => {
  const now = new Date("2026-10-20T15:00:00Z");
  const d = (over: Partial<BoardDispatchRow>): BoardDispatchRow => ({
    id: randomUUID(),
    urgency: "emergency",
    reasons: [],
    status: "open",
    callerName: null,
    callerPhone: null,
    address: null,
    intake: null,
    customerName: null,
    customerPhone: null,
    createdAt: now,
    acknowledgedAt: null,
    vapiCallId: null,
    isDemoSeed: false,
    ...over,
  });
  const c = (over: Partial<BoardCallbackRow>): BoardCallbackRow => ({
    id: randomUUID(),
    reason: "other",
    context: null,
    callerName: null,
    callerPhone: null,
    createdAt: now,
    vapiCallId: null,
    isDemoSeed: false,
    triageUrgency: null,
    triageReasons: [],
    ...over,
  });

  it("sorts safety stop, emergency, urgent, then untriaged; oldest first within each", () => {
    const ago = (m: number) => new Date(now.getTime() - m * MIN);
    const board = buildBoard(
      {
        dispatches: [
          d({ id: "emergency-new", createdAt: ago(1) }),
          d({ id: "safety", urgency: "safety_stop", createdAt: ago(0) }),
          d({ id: "emergency-old", createdAt: ago(30), status: "acknowledged" }),
        ],
        callbacks: [
          c({ id: "untriaged", createdAt: ago(300) }),
          c({ id: "urgent", triageUrgency: "urgent", createdAt: ago(2) }),
        ],
      },
      now,
    );
    expect(board.map((i) => i.id)).toEqual(["safety", "emergency-old", "emergency-new", "urgent", "untriaged"]);
  });

  it("flags overdue against the business SLAs; acknowledging stops the clock", () => {
    const sla = BUSINESS.priorityDispatchCallbackSlaMinutes;
    const at = (m: number) => new Date(now.getTime() - m * MIN);
    const [late, onTime, acked] = buildBoard(
      {
        dispatches: [
          d({ id: "a", createdAt: at(sla + 1) }),
          d({ id: "b", createdAt: at(sla - 1) }),
          d({ id: "c", createdAt: at(sla + 2), status: "acknowledged" }),
        ],
        callbacks: [],
      },
      now,
    ).sort((x, y) => x.id.localeCompare(y.id));
    expect([late.overdue, onTime.overdue, acked.overdue]).toEqual([true, false, false]);

    const [cb] = buildBoard({ dispatches: [], callbacks: [c({ createdAt: at(BUSINESS.callbackRequestSlaMinutes + 1) })] }, now);
    expect(cb).toMatchObject({ overdue: true, slaMinutes: BUSINESS.callbackRequestSlaMinutes, title: "Callback · Other" });
  });

  it("reads address, access notes and vulnerable occupants from the call's records", () => {
    const [safety] = buildBoard(
      {
        dispatches: [
          d({
            urgency: "safety_stop",
            customerName: "Dana Quillfeather",
            customerPhone: "+17185550101",
            address: { zip: "11215" },
            intake: { source: "triage_issue", flags: { issue_type: "no_heat", vulnerable_occupants: ["infant"] } },
          }),
        ],
        callbacks: [],
      },
      now,
    );
    expect(safety).toMatchObject({
      title: "Safety stop follow-up",
      callerName: "Dana Quillfeather",
      callerPhone: "+17185550101",
      address: { zip: "11215", line1: null },
      vulnerable: ["infant"],
      issue: "No heat",
    });
  });
});

describe("console repository against the seeded database", () => {
  const repo = () => createConsoleRepository(testDb());

  it("board shows open + acknowledged dispatches and open callbacks; the seed toggle hides demo rows", async () => {
    const { id: openId } = await newDispatch();
    const { id: resolvedId } = await newDispatch();
    await resolveDispatch(resolvedId, { repos: testRepos() });

    const withSeed = await repo().board({ includeSeed: true });
    const ids = withSeed.dispatches.map((r) => r.id);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(resolvedId);
    expect(withSeed.dispatches.some((r) => r.isDemoSeed)).toBe(true);
    expect(withSeed.callbacks.some((r) => r.isDemoSeed && r.triageUrgency === "urgent")).toBe(true);

    const withoutSeed = await repo().board({ includeSeed: false });
    expect(withoutSeed.dispatches.some((r) => r.isDemoSeed)).toBe(false);
    expect(withoutSeed.callbacks.some((r) => r.isDemoSeed)).toBe(false);
    expect(withoutSeed.dispatches.map((r) => r.id)).toContain(openId);
  });

  it("the seeded calls cover every outcome, plus one in progress", async () => {
    const calls = (await repo().recentCalls({ includeSeed: true, limit: 500 })).filter((c) => c.isDemoSeed);
    const records = await repo().callRecords(calls.map((c) => c.vapiCallId));
    const summaries = calls.map((c) => summarizeCall(c, records, new Date()));
    expect(new Set(summaries.map((s) => s.outcome))).toEqual(
      new Set(["booked", "priority_dispatch", "safety_stop", "callback", "not_serviceable", "incomplete"]),
    );
    expect(summaries.filter((s) => s.status === "in_progress")).toHaveLength(1);
  });

  it("a live call shows up from its first tool call, before any end-of-call report", async () => {
    const callId = `call-${randomUUID()}`;
    await callTool("check_service_area", { zip: "11215" }, { callId });
    const [row] = (await repo().recentCalls({ includeSeed: false, limit: 5 })).filter((c) => c.vapiCallId === callId);
    expect(row).toMatchObject({ hasReport: false, isDemoSeed: false });
    const records = await repo().callRecords([callId]);
    expect(records.invocations[0]).toMatchObject({ toolName: "check_service_area", ok: true });
    expect(records.invocations[0].dbMs).toBeGreaterThanOrEqual(0);
    expect(summarizeCall(row, records, new Date()).status).toBe("in_progress");
  });

  it("overview counts today's activity and tool latency", async () => {
    const from = new Date(Date.now() - 24 * 3600_000);
    const stats = await repo().overviewStats({ includeSeed: true, from, to: new Date(Date.now() + 60_000) });
    expect(stats.calls).toBeGreaterThan(0);
    expect(stats.toolCalls).toBeGreaterThan(0);
    expect(stats.avgToolMs).not.toBeNull();
    expect(stats.p95ToolMs).not.toBeNull();
    const activity = await repo().recentActivity({ includeSeed: true, limit: 10 });
    expect(activity.length).toBeGreaterThan(0);
    expect([...activity].sort((a, b) => b.at.getTime() - a.at.getTime())).toEqual(activity);
  });

  it("upcoming appointments come with member status and technician notes", async () => {
    const rows = await repo().upcomingAppointments({ includeSeed: true, from: new Date(), limit: 50 });
    const seeded = rows.filter((r) => r.isDemoSeed);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.some((r) => r.isMember)).toBe(true);
    expect(seeded.every((r) => r.technicianNotes)).toBe(true);
    expect([...rows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect((await repo().upcomingAppointments({ includeSeed: false, from: new Date(), limit: 50 })).some((r) => r.isDemoSeed)).toBe(false);
  });
});
