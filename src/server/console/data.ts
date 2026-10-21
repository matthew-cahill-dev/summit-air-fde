// Request-time data loaders for the console pages. Each one re-checks the session
// (the proxy is the first gate, this is the second) and honors the "hide seed" preference.
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session";
import { getDbFor } from "@/server/db/client";
import { addDays, todayInZone, zonedTimeToUtc } from "@/server/lib/time";
import { createConsoleRepository } from "@/server/repositories/console";
import { buildBoard } from "./board";
import { dayKey } from "./format";
import { summarizeCall } from "./outcome";

export const HIDE_SEED_COOKIE = "sa_hide_seed";

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

async function consoleContext() {
  if (!(await hasValidSession())) redirect("/login");
  const env = getEnv();
  return {
    tz: env.APP_TIMEZONE,
    includeSeed: !(await readHideSeed()),
    now: new Date(),
    repo: createConsoleRepository(getDbFor(env.DATABASE_URL)),
  };
}

export async function loadBoard() {
  const { repo, includeSeed, now, tz } = await consoleContext();
  const items = buildBoard(await repo.board({ includeSeed }), now);
  return { items, now, tz };
}

export async function loadCalls(limit = 100) {
  const { repo, includeSeed, now, tz } = await consoleContext();
  const calls = await repo.recentCalls({ includeSeed, limit });
  const records = await repo.callRecords(calls.map((c) => c.vapiCallId));
  return {
    calls: calls.map((c) => ({
      ...summarizeCall(c, records, now),
      durationMs: c.startedAt && c.endedAt ? c.endedAt.getTime() - c.startedAt.getTime() : null,
      responseP50Ms: c.responseP50Ms ?? null,
    })),
    now,
    tz,
  };
}

export async function loadCall(vapiCallId: string) {
  const { repo, now, tz } = await consoleContext();
  const call = await repo.call(vapiCallId);
  if (!call) return null;
  const records = await repo.callRecords([vapiCallId]);
  return { call, records, summary: summarizeCall(call, records, now), now, tz };
}

export async function loadAppointments(limit = 300) {
  const { repo, includeSeed, now, tz } = await consoleContext();
  const rows = await repo.upcomingAppointments({ includeSeed, from: now, limit });
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
  const { repo, includeSeed, now, tz } = await consoleContext();
  const today = todayInZone(tz, now);
  const from = zonedTimeToUtc(today, 0, 0, tz);
  const to = zonedTimeToUtc(addDays(today, 1), 0, 0, tz);
  const [stats, activity, series, recent] = await Promise.all([
    repo.overviewStats({ includeSeed, from, to }),
    repo.recentActivity({ includeSeed, limit: 25 }),
    repo.dailySeries({ includeSeed, to: now, days: 7, tz }),
    repo.recentCalls({ includeSeed, limit: 200 }),
  ]);
  // Today's outcome mix, from the same summaries the calls list uses.
  const todays = recent.filter((c) => {
    const at = c.startedAt ?? c.firstActivityAt ?? c.endedAt;
    return at !== null && at >= from && at < to;
  });
  const records = await repo.callRecords(todays.map((c) => c.vapiCallId));
  const outcomes = todays.map((c) => summarizeCall(c, records, now).outcome);
  return { stats, activity, series, outcomes, now, tz };
}

/** Sidebar counts. Errors never break the shell: they show as no badge. */
export async function loadNavCounts() {
  try {
    const { repo, includeSeed, now, tz } = await consoleContext();
    return await repo.navCounts({ includeSeed, from: zonedTimeToUtc(todayInZone(tz, now), 0, 0, tz) });
  } catch (err) {
    unstable_rethrow(err); // redirects and dynamic-rendering signals pass through
    return null;
  }
}

export async function loadCallMessages(vapiCallId: string) {
  const { repo } = await consoleContext();
  return repo.callMessages(vapiCallId);
}
