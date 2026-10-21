import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { dashboardAuth } from "@/server/auth/proxy";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session";
import { unknownCallResponse } from "@/server/console/call-not-found";
import { getDbFor } from "@/server/db/client";
import { createConsoleRepository } from "@/server/repositories/console";

// Next 16 "proxy" (formerly middleware, Node.js runtime): every dashboard route needs a
// session (src/server/auth/proxy.ts), and an unknown call ID gets a real 404 status
// (src/server/console/call-not-found.ts).
export async function proxy(request: NextRequest) {
  const env = getEnv();
  const gate = dashboardAuth(request, env.DASHBOARD_PASSWORD);
  // Only signed-in viewers learn whether a call ID exists; everyone else gets the login redirect.
  if (!verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, env.DASHBOARD_PASSWORD)) return gate;
  const repo = createConsoleRepository(getDbFor(env.DATABASE_URL));
  return (await unknownCallResponse(request, (id) => repo.callExists(id))) ?? gate;
}

export const config = {
  // Vapi webhooks and the health check keep their own auth; static assets skip the check.
  matcher: ["/((?!api/vapi/|api/health$|_next/static|_next/image|favicon\\.ico$).*)"],
};
