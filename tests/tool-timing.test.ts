import { afterEach, describe, expect, it, vi } from "vitest";
import { timedRepositories } from "@/server/vapi/dispatcher";
import type { Repositories } from "@/server/repositories";
import { callTool } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function loggedEvents(spy: { mock: { calls: unknown[][] } }, event: string) {
  return spy.mock.calls
    .map(([line]) => (typeof line === "string" && line.startsWith("{") ? (JSON.parse(line) as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => e?.event === event);
}

describe("tool_invocation timing", () => {
  it("logs total, idempotency, handler, db and record time", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callTool("lookup_customer", {}, { callerNumber: "+13475550102" });
    const [line] = loggedEvents(spy, "tool_invocation");
    expect(line).toMatchObject({ tool: "lookup_customer", ok: true, replayed: false });
    for (const field of ["latency_ms", "total_ms", "idempotency_ms", "handler_ms", "db_ms", "record_ms"]) {
      expect(typeof line[field], field).toBe("number");
    }
    expect(line.db_ms as number).toBeGreaterThan(0); // the caller-context query ran through the timed repos
    expect(line.total_ms as number).toBeGreaterThanOrEqual(line.handler_ms as number);
  });

  it("timedRepositories adds each repository call's time and passes results through", async () => {
    const clock = { dbMs: 0 };
    const repos = {
      customers: { findByLastName: async () => new Promise((r) => setTimeout(() => r(["row"]), 15)) },
    } as unknown as Repositories;
    const timed = timedRepositories(repos, clock);
    expect(await timed.customers.findByLastName({ lastName: "x" })).toEqual(["row"]);
    expect(clock.dbMs).toBeGreaterThanOrEqual(10);
  });
});
