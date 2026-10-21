"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE } from "@/server/auth/session";
import { acknowledgeDispatch, completeCallback, resolveDispatch, type BoardActionResult } from "@/server/console/actions";
import { HIDE_SEED_COOKIE, hasValidSession } from "@/server/console/data";
import { getDbFor } from "@/server/db/client";
import { createRepositories } from "@/server/repositories";

// Every action re-checks the session itself: the proxy matcher is not the only gate.
async function authorized<T>(fn: () => Promise<T>): Promise<T | BoardActionResult> {
  if (!(await hasValidSession())) return { ok: false, error: "Your session expired. Sign in again." };
  return fn();
}

const repos = () => createRepositories(getDbFor(getEnv().DATABASE_URL));

async function boardAction(fn: (deps: { repos: ReturnType<typeof repos> }) => Promise<BoardActionResult>) {
  const result = await authorized(() => fn({ repos: repos() }));
  refresh();
  return result;
}

export async function acknowledgeDispatchAction(id: string): Promise<BoardActionResult> {
  return boardAction((deps) => acknowledgeDispatch(id, deps));
}

export async function resolveDispatchAction(id: string): Promise<BoardActionResult> {
  return boardAction((deps) => resolveDispatch(id, deps));
}

export async function completeCallbackAction(id: string): Promise<BoardActionResult> {
  return boardAction((deps) => completeCallback(id, deps));
}

export async function setHideSeedAction(hide: boolean): Promise<void> {
  if (!(await hasValidSession())) return;
  const jar = await cookies();
  jar.set(HIDE_SEED_COOKIE, hide ? "1" : "0", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  refresh();
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
