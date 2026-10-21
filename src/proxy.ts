import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { dashboardAuth } from "@/server/auth/proxy";

// Next 16 "proxy" (formerly middleware): every dashboard route needs a session.
// See src/server/auth/proxy.ts.
export function proxy(request: NextRequest) {
  return dashboardAuth(request, getEnv().DASHBOARD_PASSWORD);
}

export const config = {
  // Vapi webhooks and the health check keep their own auth; static assets skip the check.
  matcher: ["/((?!api/vapi/|api/health$|_next/static|_next/image|favicon\\.ico$).*)"],
};
