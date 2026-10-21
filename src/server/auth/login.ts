import { logEvent } from "@/server/lib/log";
import { clientKey, createLoginRateLimiter, type LoginRateLimiter } from "./rate-limit";
import { createSessionToken, passwordMatches } from "./session";

export type LoginResult = { ok: true; token: string } | { ok: false; error: string };

const processLimiter = createLoginRateLimiter();

/** Throttled, constant-time password check. Returns a fresh session token on success. */
export function attemptLogin(input: {
  password: string;
  configuredPassword: string;
  headers: Headers;
  limiter?: LoginRateLimiter;
  now?: Date;
}): LoginResult {
  const limiter = input.limiter ?? processLimiter;
  const key = clientKey(input.headers);
  const decision = limiter.check(key);
  if (!decision.allowed) {
    logEvent("dashboard_login_throttled", {});
    const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
    return { ok: false, error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }
  if (!passwordMatches(input.password, input.configuredPassword)) {
    limiter.recordFailure(key);
    logEvent("dashboard_login_failed", {});
    return { ok: false, error: "That password isn't right." };
  }
  limiter.reset(key);
  logEvent("dashboard_login", {});
  return { ok: true, token: createSessionToken(input.configuredPassword, input.now) };
}
