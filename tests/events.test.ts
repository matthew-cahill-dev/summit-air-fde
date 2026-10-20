import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { calls } from "@/server/db/schema";
import { handleEventsRequest } from "@/server/vapi/http";
import { post, testDb, testDeps } from "./helpers";

function report(callId: string, overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      startedAt: "2026-10-20T14:00:00.000Z",
      endedAt: "2026-10-20T14:03:30.000Z",
      call: { id: callId, customer: { number: "+17185550101" } },
      artifact: { transcript: "AI: Thanks for calling Summit Air.\nUser: Hi." },
      analysis: { summary: "Caller asked about a tune-up." },
      ...overrides,
    },
  };
}

describe("POST /api/vapi/events", () => {
  it("upserts end-of-call-report by vapi_call_id", async () => {
    const callId = `call-${randomUUID()}`;
    let res = await handleEventsRequest(post("/api/vapi/events", report(callId)), testDeps());
    expect(res.status).toBe(200);

    res = await handleEventsRequest(post("/api/vapi/events", report(callId, { endedReason: "assistant-ended-call", analysis: {} })), testDeps());
    expect(res.status).toBe(200);

    const rows = await testDb().select().from(calls).where(eq(calls.vapiCallId, callId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      callerPhone: "+17185550101",
      endedReason: "assistant-ended-call",
      summary: "Caller asked about a tune-up.", // kept: second report had no summary
      isTest: true,
    });
    expect(rows[0].startedAt?.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(rows[0].transcript).toContain("Summit Air");
  });

  it("ignores other message types with 200", async () => {
    const res = await handleEventsRequest(post("/api/vapi/events", { message: { type: "status-update", status: "in-progress" } }), testDeps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "status-update" });
  });
});
