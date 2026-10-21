// Request-time data loaders for the console pages. Each one re-checks the session (the proxy is
// the first gate, this is the second) and honors the viewer's scope: seed data and test runs
// (Vapi simulations, web calls) are hidden unless turned on. Every number comes from metrics.ts.
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session";
import { getDbFor } from "@/server/db/client";
import type { CallActivityRow, Scope } from "@/server/repositories";
import { createConsoleRepository } from "@/server/repositories/console";
import { buildBoard, filterBoard, type BoardKind, type BoardTab } from "./board";
import { dayKey } from "./format";
import { lastDaysWindow, navCounts, todayWindow, toolHealth, todayMetrics, callsByHour, needsAttention, callTime } from "./metrics";
import { summarizeCall } from "./outcome";

export const HIDE_SEED_COOKIE = "sa_hide_seed";
export const SHOW_TESTS_COOKIE = "sa_show_tests";

export async function hasValidSession(): Promise<boolean> {
  // Session expiry and every loader below read the clock, which must happen at request time.
  await connection();
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value, getEnv().DASHBOARD_PASSWORD);
}

/** Seed data is hidden unless the viewer turned "Show seed data" on, so a demo shows only real calls. */
export async function readHideSeed(): Promise<boolean> {
  return (await cookies()).get(HIDE_SEED_COOKIE)?.value !== "0";
}

/** Test runs (simulations, web calls) are hidden unless the viewer turned "Show test runs" on. */
export async function readShowTests(): Promise<boolean> {
  return (await cookies()).get(SHOW_TESTS_COOKIE)?.value === "1";
}

async function consoleContext() {
  if (!(await hasValidSession())) redirect("/login");
  const env = getEnv();
  const scope: Scope = { includeSeed: !(await readHideSeed()), includeTests: await readShowTests() };
  return { tz: env.APP_TIMEZONE, scope, now: new Date(), repo: createConsoleRepository(getDbFor(env.DATABASE_URL)) };
}

export type BoardRange = "today" | "7d";

export async function loadBoard(view: { tab: BoardTab; kind: BoardKind; range: BoardRange }) {
  const { repo, scope, now, tz } = await consoleContext();
  const resolvedSince = (view.range === "today" ? todayWindow(tz, now) : lastDaysWindow(tz, now, 7)).from;
  const all = buildBoard(await repo.board({ ...scope, resolvedSince }), now);
  const items = filterBoard(all, view.tab, view.kind);
  if (view.tab === "resolved") items.sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));
  return { all, items, now, tz };
}

async function summaries(repo: ReturnType<typeof createConsoleRepository>, calls: CallActivityRow[], now: Date) {
  const records = await repo.callRecords(calls.map((c) => c.vapiCallId));
  return calls.map((c) => ({
    ...summarizeCall(c, records, now),
    durationMs: c.startedAt && c.endedAt ? c.endedAt.getTime() - c.startedAt.getTime() : null,
    responseP50Ms: c.responseP50Ms ?? null,
  }));
}

export async function loadCalls(limit = 300) {
  const { repo, scope, now, tz } = await consoleContext();
  const calls = await repo.recentCalls({ ...scope, limit });
  return { calls: await summaries(repo, calls, now), now, tz, todayStart: todayWindow(tz, now).from };
}

export async function loadCall(vapiCallId: string) {
  const { repo, now, tz } = await consoleContext();
  const call = await repo.call(vapiCallId);
  if (!call) return null;
  const records = await repo.callRecords([vapiCallId]);
  // The appointments this call created, with their lifecycle (completed, cancelled, rescheduled).
  const appointments = records.appointments.length ? await repo.appointments({ includeSeed: true, includeTests: true, ids: records.appointments.map((a) => a.id), limit: 20 }) : [];
  return { call, records, appointments, summary: summarizeCall(call, records, now), now, tz };
}

export type AppointmentsView = "upcoming" | "closed";

export async function loadAppointments(opts: { view: AppointmentsView; bookedToday: boolean }, limit = 300) {
  const { repo, scope, now, tz } = await consoleContext();
  const rows = opts.bookedToday
    ? await repo.appointments({ ...scope, bookedSince: todayWindow(tz, now).from, limit })
    : opts.view === "closed"
      ? (await repo.appointments({ ...scope, from: new Date(8.64e15), closedSince: lastDaysWindow(tz, now, 7).from, limit })).filter((a) => a.stage !== "scheduled")
      : // Scheduled ones whose window ends after the start of today, so today's visits stay until they're marked.
        await repo.appointments({ ...scope, from: todayWindow(tz, now).from, limit });
  const days: Array<{ key: string; first: Date; items: typeof rows }> = [];
  for (const row of rows) {
    const key = dayKey(row.startsAt, tz);
    const day = days.at(-1);
    if (day?.key === key) day.items.push(row);
    else days.push({ key, first: row.startsAt, items: [row] });
  }
  return { days, total: rows.length, now, tz };
}

export async function loadOverview() {
  const { repo, scope, now, tz } = await consoleContext();
  const today = todayWindow(tz, now);
  const [boardRows, calls, booked, toolRows, activity] = await Promise.all([
    repo.board({ ...scope, resolvedSince: today.from }),
    repo.recentCalls({ ...scope, since: today.from, limit: 2000 }),
    repo.appointments({ ...scope, bookedSince: today.from, limit: 2000 }),
    repo.toolHealthRows({ ...scope, from: today.from }),
    repo.recentActivity({ ...scope, limit: 15 }),
  ]);
  const board = buildBoard(boardRows, now);
  const callSummaries = await summaries(repo, calls, now);
  const metrics = todayMetrics({ calls: callSummaries, board, bookingsToday: booked.length, toolRows, window: today });
  return {
    metrics,
    attention: needsAttention(board),
    byHour: callsByHour(callSummaries, tz, today),
    health: toolHealth(toolRows),
    outcomes: callSummaries.map((c) => c.outcome),
    activity,
    now,
    tz,
  };
}

/** Sidebar counts, from the same board and call rows (and definitions) as the pages. Never breaks the shell. */
export async function loadNavCounts() {
  try {
    const { repo, scope, now, tz } = await consoleContext();
    const today = todayWindow(tz, now);
    const [boardRows, calls] = await Promise.all([repo.board(scope), repo.recentCalls({ ...scope, since: today.from, limit: 2000 })]);
    return navCounts(buildBoard(boardRows, now), calls, today);
  } catch (err) {
    unstable_rethrow(err); // redirects and dynamic-rendering signals pass through
    return null;
  }
}

export async function loadCallMessages(vapiCallId: string) {
  const { repo } = await consoleContext();
  return repo.callMessages(vapiCallId);
}

export { callTime };
