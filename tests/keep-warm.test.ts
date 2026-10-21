import { describe, expect, it, vi } from "vitest";
import { handleEventsRequest } from "@/server/vapi/http";
import type { Repositories } from "@/server/repositories";
import { post, testDeps, testRepos } from "./helpers";

const statusUpdate = (status: string) => ({ message: { type: "status-update", status, call: { id: "call-warm" } } });

function depsWithPing(ping: () => Promise<void>) {
  return testDeps({ repos: (): Repositories => ({ ...testRepos(), health: { ping } }) });
}

/** Let fire-and-forget promise chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("keep-warm on status-update", () => {
  it("runs one ping when the call goes in-progress", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const res = await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress")), depsWithPing(ping));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warming: true });
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("answers Vapi before the ping finishes (a cold database can't delay the response)", async () => {
    let release!: () => void;
    const ping = vi.fn(() => new Promise<void>((r) => (release = r)));
    const deps = depsWithPing(ping);

    const res = await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress")), deps);
    expect(await res.json()).toEqual({ ok: true, warming: true });
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);

    // A second call starting while the first ping is still in flight doesn't stack another.
    const again = await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress")), deps);
    expect(await again.json()).toEqual({ ok: true, warming: false });
    expect(ping).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress")), deps);
    await flush();
    expect(ping).toHaveBeenCalledTimes(2);
    release(); // the next ping's promise; leave nothing in flight for later tests
    await flush();
  });

  it.each(["scheduled", "queued", "ringing", "forwarding", "ended", ""])("ignores status %j without touching the database", async (status) => {
    const ping = vi.fn(() => Promise.resolve());
    const res = await handleEventsRequest(post("/api/vapi/events", statusUpdate(status)), depsWithPing(ping));
    expect(await res.json()).toEqual({ ok: true, ignored: "status-update" });
    await flush();
    expect(ping).not.toHaveBeenCalled();
  });

  it("logs a failed ping and still answers 200", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ping = vi.fn(() => Promise.reject(new Error("database is starting up")));
    try {
      const res = await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress")), depsWithPing(ping));
      expect(res.status).toBe(200);
      await flush();
      await flush();
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(events).toContainEqual(expect.objectContaining({ event: "db_keep_warm", ok: false, error: "database is starting up" }));
    } finally {
      log.mockRestore();
    }
  });

  it("requires the Vapi secret", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const res = await handleEventsRequest(post("/api/vapi/events", statusUpdate("in-progress"), "Bearer wrong"), depsWithPing(ping));
    expect(res.status).toBe(401);
    await flush();
    expect(ping).not.toHaveBeenCalled();
  });

  it("the real ping is a cheap select 1", async () => {
    await expect(testRepos().health.ping()).resolves.toBeUndefined();
  });
});
