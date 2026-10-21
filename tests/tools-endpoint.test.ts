import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { toolInvocations } from "@/server/db/schema";
import { handleToolsRequest } from "@/server/vapi/http";
import { payloadOf, post, testDb, testDeps, toolCallsBody } from "./helpers";

async function callTools(body: unknown) {
  const res = await handleToolsRequest(post("/api/vapi/tools", body), testDeps());
  expect(res.status).toBe(200);
  return (await res.json()) as { results: Array<{ toolCallId: string; result?: string; error?: string }> };
}

describe("POST /api/vapi/tools", () => {
  it("handles object and string arguments end to end", async () => {
    const callId = `call-${randomUUID()}`;
    const { results } = await callTools(
      toolCallsBody({
        callId,
        calls: [
          { id: "obj", name: "check_service_area", arguments: { zip: "11215" } },
          { id: "str", name: "check_service_area", arguments: '{"zip":"10024"}' },
        ],
      }),
    );
    expect(results.map((r) => r.toolCallId)).toEqual(["obj", "str"]);
    expect(payloadOf(results[0])).toMatchObject({ ok: true, in_area: true, county: "Kings" });
    expect(payloadOf(results[1])).toMatchObject({ ok: true, in_area: true, county: "New York" });
  });

  it("returns exactly one of result/error per toolCallId, as single-line strings", async () => {
    const { results } = await callTools(
      toolCallsBody({
        callId: `call-${randomUUID()}`,
        calls: [
          { id: "good", name: "check_service_area", arguments: { zip: "11372" } },
          { id: "bad", name: "check_service_area", arguments: {} },
          { id: "unknown", name: "book_spaceship", arguments: {} },
          { id: "garbled", name: "check_service_area", arguments: "{oops" },
        ],
      }),
    );
    expect(results).toHaveLength(4);
    for (const r of results) {
      const keys = Object.keys(r).sort();
      expect(keys.length).toBe(2);
      expect(keys).toContain("toolCallId");
      const text = (r.result ?? r.error)!;
      expect(typeof text).toBe("string");
      expect(text).not.toMatch(/\n/);
    }
    expect(results[0].result).toBeDefined();
    expect(results[1].error).toBeDefined();
    expect(payloadOf(results[2])).toMatchObject({ ok: false, error_code: "unknown_tool" });
    expect(payloadOf(results[3])).toMatchObject({ ok: false, error_code: "invalid_arguments" });
  });

  it("names missing and invalid fields in Zod errors", async () => {
    const { results } = await callTools(
      toolCallsBody({
        callId: `call-${randomUUID()}`,
        calls: [
          { id: "missing", name: "check_service_area", arguments: {} },
          { id: "invalid", name: "check_service_area", arguments: { zip: "abc", property_type: "castle" } },
        ],
      }),
    );
    const missing = payloadOf(results[0]);
    expect(missing).toMatchObject({ ok: false, error_code: "invalid_arguments", message: "Missing: zip" });
    expect(missing.invalid_fields).toEqual([{ field: "zip", problem: "required" }]);
    expect(missing.say).toContain("zip");

    const invalid = payloadOf(results[1]);
    expect(invalid.message).toMatch(/^Invalid: zip \(must be a 5-digit ZIP code\), property_type \(/);
    expect((invalid.invalid_fields as Array<{ field: string }>).map((f) => f.field)).toEqual(["zip", "property_type"]);
  });

  it("replays an identical result for a duplicate (callId, tool, args) and records one row", async () => {
    const callId = `call-${randomUUID()}`;
    const body = (toolCallId: string, args: unknown) =>
      toolCallsBody({ callId, callerNumber: "+17185550101", calls: [{ id: toolCallId, name: "lookup_customer", arguments: args }] });

    const first = await callTools(body("tc-1", { phone: "718-555-0101" }));
    // Same args as a JSON string with different key spacing, new toolCallId (a Vapi retry).
    const second = await callTools(body("tc-2", '{ "phone" : "718-555-0101" }'));

    expect(second.results[0].result).toBe(first.results[0].result);
    expect(second.results[0].toolCallId).toBe("tc-2");

    const [{ n }] = await testDb()
      .select({ n: count() })
      .from(toolInvocations)
      .where(eq(toolInvocations.vapiCallId, callId));
    expect(n).toBe(1);

    const [row] = await testDb().select().from(toolInvocations).where(eq(toolInvocations.vapiCallId, callId));
    expect(row.toolName).toBe("lookup_customer");
    expect(row.ok).toBe(true);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not replay across different calls", async () => {
    const args = { zip: "11105" };
    const a = await callTools(toolCallsBody({ callId: `call-${randomUUID()}`, calls: [{ id: "x", name: "check_service_area", arguments: args }] }));
    const b = await callTools(toolCallsBody({ callId: `call-${randomUUID()}`, calls: [{ id: "x", name: "check_service_area", arguments: args }] }));
    expect(a.results[0].result).toBe(b.results[0].result); // same answer…
    const rows = await testDb().select({ n: count() }).from(toolInvocations).where(eq(toolInvocations.toolName, "check_service_area"));
    expect(rows[0].n).toBeGreaterThanOrEqual(2); // …but each call recorded
  });

  it("answers 200 with empty results for non tool-calls bodies", async () => {
    expect(await callTools({ message: { type: "status-update" } })).toEqual({ results: [] });
    expect(await callTools("not json")).toEqual({ results: [] });
  });
});
