import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/**
 * Paths that never need a dashboard session. The Vapi webhooks and health check
 * have their own auth (bearer secret / none) and are also excluded by the matcher;
 * this is the second line of defense if the matcher ever drifts.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/vapi/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

/** Dashboard session gate. Pages redirect to /login; anything else (e.g. a Server Action POST) gets 401. */
export function dashboardAuth(request: NextRequest, password: string, now: Date = new Date()): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authed = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, password, now);

  if (pathname === "/login") {
    return authed && request.method === "GET"
      ? NextResponse.redirect(new URL("/dispatch", request.url))
      : NextResponse.next();
  }
  if (authed || isPublicPath(pathname)) return NextResponse.next();

  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}
