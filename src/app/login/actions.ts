"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { attemptLogin } from "@/server/auth/login";
import { safeNextPath, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";

export type LoginState = { error: string | null };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = attemptLogin({
    password: String(formData.get("password") ?? ""),
    configuredPassword: getEnv().DASHBOARD_PASSWORD,
    headers: await headers(),
  });
  if (!result.ok) return { error: result.error };
  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions());
  redirect(safeNextPath(formData.get("next")));
}
