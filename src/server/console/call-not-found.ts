// A real 404 for unknown call IDs. The call page checks existence inside <Suspense>
// (cacheComponents streams the console shell first), and once streaming starts the
// status is already 200. So the proxy checks first, before anything renders, and
// rewrites to a path no route matches: Next serves app/not-found.tsx for that with a
// true 404. (A rewrite's own `status` is ignored for page routes; verified on Next 16.4.)
import { NextResponse, type NextRequest } from "next/server";

/** "/calls/<id>" → the decoded call ID; null for any other path (including "/calls"). */
export function callIdFromPath(pathname: string): string | null {
  const m = /^\/calls\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Two segments under /calls match no route, so this always renders the root not-found with 404. */
export const UNMATCHED_CALL_PATH = "/calls/not-found/404";

/** A rewrite to the 404 page, or null when the call exists or the path isn't a call page. */
export async function unknownCallResponse(
  request: NextRequest,
  exists: (vapiCallId: string) => Promise<boolean>,
): Promise<NextResponse | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const callId = callIdFromPath(request.nextUrl.pathname);
  if (!callId || (await exists(callId))) return null;
  return NextResponse.rewrite(new URL(UNMATCHED_CALL_PATH, request.url));
}
