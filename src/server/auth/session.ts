// Dashboard session: a stateless, signed cookie. The HMAC key is derived from
// DASHBOARD_PASSWORD, so changing the password signs every session out.
// Runs in the proxy (Node runtime) and in Server Actions; no database involved.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "sa_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const VERSION = "v1";

function sessionKey(password: string): Buffer {
  return Buffer.from(hkdfSync("sha256", password, "summit-air", "dashboard-session-v1", 32));
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", sessionKey(password)).update(payload).digest("base64url");
}

/** Constant-time string compare: both sides are hashed so length doesn't leak. */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True when the submitted password matches. Empty input or an empty configured password never match. */
export function passwordMatches(submitted: string, configured: string): boolean {
  if (!submitted || !configured) return false;
  return constantTimeEqual(submitted, configured);
}

/** `v1.<expires epoch seconds>.<nonce>.<signature>` */
export function createSessionToken(password: string, now: Date = new Date(), ttlSeconds = SESSION_TTL_SECONDS): string {
  const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload = `${VERSION}.${expires}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload, password)}`;
}

export function verifySessionToken(token: string | undefined | null, password: string, now: Date = new Date()): boolean {
  if (!token || !password) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires) || expires <= Math.floor(now.getTime() / 1000)) return false;
  const payload = parts.slice(0, 3).join(".");
  return constantTimeEqual(parts[3], sign(payload, password));
}

/** Cookie attributes. `secure` is off only under `next dev` (plain-http localhost in some browsers). */
export function sessionCookieOptions(ttlSeconds = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax" as const,
    path: "/",
    maxAge: ttlSeconds,
  };
}

/** Only same-origin paths survive the post-login redirect. */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/dispatch";
  if (raw === "/login" || raw.startsWith("/login?")) return "/dispatch";
  return raw;
}
