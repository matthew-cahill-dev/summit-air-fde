// In-memory login throttle: at most `maxFailures` failed attempts per client per
// window. Per process, which fits the single Reserved VM deployment; a restart clears it.

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export type LoginRateLimiter = {
  check(key: string): RateLimitDecision;
  recordFailure(key: string): void;
  reset(key: string): void;
};

export function createLoginRateLimiter(
  opts: { maxFailures?: number; windowMs?: number; now?: () => number } = {},
): LoginRateLimiter {
  const maxFailures = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const recent = (key: string) => {
    const cutoff = now() - windowMs;
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };

  return {
    check(key) {
      const hits = recent(key);
      if (hits.length < maxFailures) return { allowed: true };
      return { allowed: false, retryAfterMs: Math.max(0, hits[0] + windowMs - now()) };
    },
    recordFailure(key) {
      // Bound memory if someone sprays many client keys.
      if (failures.size > 10_000) failures.clear();
      failures.set(key, [...recent(key), now()]);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

/**
 * Client key for throttling. Behind Replit's proxy the right-most X-Forwarded-For
 * entry is the one the proxy appended, so a client can't spoof it by sending its own header.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last || headers.get("x-real-ip") || "unknown";
}
