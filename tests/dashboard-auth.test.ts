import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { attemptLogin } from "@/server/auth/login";
import { dashboardAuth } from "@/server/auth/proxy";
import { clientKey, createLoginRateLimiter } from "@/server/auth/rate-limit";
import {
  createSessionToken,
  passwordMatches,
  safeNextPath,
  SESSION_COOKIE,
  verifySessionToken,
} from "@/server/auth/session";

const PASSWORD = "test-dashboard-pw"; // tests/setup-env.ts
const NOW = new Date("2026-10-20T15:00:00Z");

function request(path: string, opts: { token?: string; method?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers: opts.token ? { cookie: `${SESSION_COOKIE}=${opts.token}` } : {},
  });
}

const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("session tokens", () => {
  it("verifies a fresh token signed with the dashboard password", () => {
    const token = createSessionToken(PASSWORD, NOW);
    expect(verifySessionToken(token, PASSWORD, NOW)).toBe(true);
  });

  it("rejects expired, tampered, foreign-key and malformed tokens", () => {
    const token = createSessionToken(PASSWORD, NOW, 60);
    expect(verifySessionToken(token, PASSWORD, new Date(NOW.getTime() + 61_000))).toBe(false);

    const [v, exp, nonce, sig] = token.split(".");
    expect(verifySessionToken([v, String(Number(exp) + 3600), nonce, sig].join("."), PASSWORD, NOW)).toBe(false);
    expect(verifySessionToken([v, exp, nonce, sig.slice(0, -2) + "xx"].join("."), PASSWORD, NOW)).toBe(false);
    // Changing the password invalidates every existing session.
    expect(verifySessionToken(token, "a-new-password", NOW)).toBe(false);

    for (const bad of ["", "v1", "v1.a.b", "v2.1.2.3", `v1.notanumber.${nonce}.${sig}`, null, undefined]) {
      expect(verifySessionToken(bad, PASSWORD, NOW)).toBe(false);
    }
  });

  it("compares passwords exactly and never matches empty input", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(passwordMatches(`${PASSWORD} `, PASSWORD)).toBe(false);
    expect(passwordMatches(PASSWORD.slice(0, -1), PASSWORD)).toBe(false);
    expect(passwordMatches("", PASSWORD)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });

  it("only redirects to same-origin paths after login", () => {
    expect(safeNextPath("/calls/abc?x=1")).toBe("/calls/abc?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "calls", "/login", "/login?next=/x", null, 42]) {
      expect(safeNextPath(bad)).toBe("/dispatch");
    }
  });
});

describe("login rate limiting", () => {
  it("blocks a client after 5 failures in the window, then lets it retry", () => {
    let t = 0;
    const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("1.2.3.4").allowed).toBe(true);
      limiter.recordFailure("1.2.3.4");
    }
    const blocked = limiter.check("1.2.3.4");
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 60_000 });
    expect(limiter.check("5.6.7.8").allowed).toBe(true); // other clients unaffected
    t = 60_001;
    expect(limiter.check("1.2.3.4").allowed).toBe(true);
  });

  it("attemptLogin throttles even the right password once blocked, and success clears failures", () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2 });
    const headers = new Headers({ "x-forwarded-for": "9.9.9.9" });
    const login = (password: string) => attemptLogin({ password, configuredPassword: PASSWORD, headers, limiter, now: NOW });

    expect(login("wrong")).toEqual({ ok: false, error: "That password isn't right." });
    const ok = login(PASSWORD);
    expect(ok.ok).toBe(true);
    expect(ok.ok && verifySessionToken(ok.token, PASSWORD, NOW)).toBe(true);

    login("wrong");
    login("wrong");
    const throttled = login(PASSWORD);
    expect(throttled.ok).toBe(false);
    expect(!throttled.ok && throttled.error).toMatch(/Too many attempts/);
  });

  it("keys on the proxy-appended (right-most) X-Forwarded-For entry", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.7" }))).toBe("10.0.0.7");
    expect(clientKey(new Headers({ "x-real-ip": "10.0.0.8" }))).toBe("10.0.0.8");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});

describe("dashboard auth proxy", () => {
  const token = createSessionToken(PASSWORD, NOW);

  it("redirects an unauthenticated page view to /login with the return path", () => {
    const res = dashboardAuth(request("/calls/demo-1?x=1"), PASSWORD, NOW);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/calls/demo-1?x=1");

    const root = dashboardAuth(request("/"), PASSWORD, NOW);
    expect(new URL(root.headers.get("location")!).search).toBe("");
  });

  it("answers 401 to an unauthenticated POST (e.g. a Server Action) instead of redirecting", async () => {
    const res = dashboardAuth(request("/dispatch", { method: "POST" }), PASSWORD, NOW);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("lets a valid session through to every dashboard route", () => {
    for (const path of ["/dispatch", "/calls", "/calls/abc", "/appointments", "/overview", "/"]) {
      expect(passedThrough(dashboardAuth(request(path, { token }), PASSWORD, NOW))).toBe(true);
    }
    expect(passedThrough(dashboardAuth(request("/dispatch", { token, method: "POST" }), PASSWORD, NOW))).toBe(true);
  });

  it("rejects an expired or forged cookie", () => {
    const expired = createSessionToken(PASSWORD, new Date(NOW.getTime() - 13 * 3600_000));
    expect(dashboardAuth(request("/dispatch", { token: expired }), PASSWORD, NOW).status).toBe(307);
    const forged = createSessionToken("someone-elses-password", NOW);
    expect(dashboardAuth(request("/dispatch", { token: forged }), PASSWORD, NOW).status).toBe(307);
  });

  it("serves /login to signed-out users and bounces signed-in users to the board", () => {
    expect(passedThrough(dashboardAuth(request("/login"), PASSWORD, NOW))).toBe(true);
    expect(passedThrough(dashboardAuth(request("/login", { method: "POST" }), PASSWORD, NOW))).toBe(true);
    const res = dashboardAuth(request("/login", { token }), PASSWORD, NOW);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dispatch");
  });

  it("never gates the Vapi webhooks or the health check", () => {
    for (const path of ["/api/vapi/tools", "/api/vapi/events", "/api/vapi/assistant-request", "/api/health"]) {
      expect(passedThrough(dashboardAuth(request(path, { method: "POST" }), PASSWORD, NOW))).toBe(true);
    }
  });

  it("uses DASHBOARD_PASSWORD from the environment", () => {
    expect(proxy(request("/dispatch")).status).toBe(307);
    expect(passedThrough(proxy(request("/dispatch", { token: createSessionToken(PASSWORD) })))).toBe(true);
  });

  it("matcher excludes the Vapi webhooks, health check and static assets only", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const path of ["/", "/dispatch", "/calls/demo-seed-call-01", "/appointments", "/overview", "/login", "/api/other", "/api/healthz"]) {
      expect([path, matches(path)]).toEqual([path, true]);
    }
    for (const path of ["/api/vapi/tools", "/api/vapi/events", "/api/vapi/assistant-request", "/api/health", "/_next/static/chunks/app.js", "/_next/image", "/favicon.ico"]) {
      expect([path, matches(path)]).toEqual([path, false]);
    }
  });
});
