"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE } from "@/server/auth/session";
import {
  cancelAppointmentAction as cancelAppointmentImpl,
  completeAppointment,
  markCalledBack,
  rescheduleAppointmentAction as rescheduleImpl,
  resolveItem,
  undoAction,
  type ConsoleActionResult,
} from "@/server/console/actions";
import { HIDE_SEED_COOKIE, SHOW_TESTS_COOKIE, hasValidSession } from "@/server/console/data";
import { getDbFor } from "@/server/db/client";
import { createRepositories } from "@/server/repositories";
import { createConsoleRepository } from "@/server/repositories/console";
import { rescheduleOptions, type WindowOption } from "@/server/services/appointment-lifecycle";
import { parseTranscript } from "@/server/console/steps";

// Every action re-checks the session itself: the proxy matcher is not the only gate.
const repos = () => createRepositories(getDbFor(getEnv().DATABASE_URL));
const deps = () => ({ repos: repos(), timeZone: getEnv().APP_TIMEZONE });

async function act(fn: () => Promise<ConsoleActionResult>): Promise<ConsoleActionResult> {
  if (!(await hasValidSession())) return { ok: false, error: "Your session expired. Sign in again." };
  const result = await fn();
  refresh();
  return result;
}

export async function calledBackAction(kind: "dispatch" | "callback", id: string, by: string): Promise<ConsoleActionResult> {
  return act(() => markCalledBack({ kind, id, by }, deps()));
}

export async function resolveAction(kind: "dispatch" | "callback", id: string, resolution: string, note: string, by: string): Promise<ConsoleActionResult> {
  return act(() => resolveItem({ kind, id, resolution, note, by }, deps()));
}

export async function closeAppointmentAction(id: string, outcome: "completed" | "no_show", note: string, by: string): Promise<ConsoleActionResult> {
  return act(() => completeAppointment({ id, outcome, note, by }, deps()));
}

export async function cancelAppointmentAction(id: string, by: string): Promise<ConsoleActionResult> {
  return act(() => cancelAppointmentImpl({ id, by }, deps()));
}

export async function rescheduleAppointmentAction(id: string, slotId: string, by: string): Promise<ConsoleActionResult> {
  return act(() => rescheduleImpl({ id, slotId, by }, deps()));
}

export async function undoConsoleAction(token: unknown): Promise<ConsoleActionResult> {
  return act(() => undoAction(token, deps()));
}

/** The last lines of a call's conversation, for the dispatch side sheet. */
export async function callExcerptAction(vapiCallId: string): Promise<Array<{ role: "caller" | "ava" | null; text: string }>> {
  if (!(await hasValidSession())) return [];
  const repo = createConsoleRepository(getDbFor(getEnv().DATABASE_URL));
  const messages = await repo.callMessages(vapiCallId);
  if (messages.length) return messages.slice(-8).map((m) => ({ role: m.role, text: m.text }));
  const call = await repo.call(vapiCallId);
  return call?.transcript ? parseTranscript(call.transcript).slice(-8) : [];
}

/** Real open windows for the reschedule picker (the same selection get_availability uses). */
export async function rescheduleOptionsAction(appointmentId: string): Promise<{ ok: true; options: WindowOption[] } | { ok: false; error: string }> {
  if (!(await hasValidSession())) return { ok: false, error: "Your session expired. Sign in again." };
  const env = getEnv();
  const [a] = await createConsoleRepository(getDbFor(env.DATABASE_URL)).appointments({ includeSeed: true, includeTests: true, ids: [appointmentId], limit: 1 });
  if (!a || a.stage !== "scheduled") return { ok: false, error: "That appointment isn't scheduled any more." };
  const options = await rescheduleOptions(a, { repos: repos(), now: new Date(), timeZone: env.APP_TIMEZONE });
  return { ok: true, options };
}

async function setPreference(name: string, on: boolean): Promise<void> {
  if (!(await hasValidSession())) return;
  const jar = await cookies();
  jar.set(name, on ? "1" : "0", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  refresh();
}

export async function setHideSeedAction(hide: boolean): Promise<void> {
  return setPreference(HIDE_SEED_COOKIE, hide);
}

/** "Show test runs": Vapi simulations, web calls and dashboard tests. Off by default. */
export async function setShowTestsAction(show: boolean): Promise<void> {
  return setPreference(SHOW_TESTS_COOKIE, show);
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
