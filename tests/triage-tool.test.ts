import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dispatchRequests } from "@/server/db/schema";
import { handleToolsRequest } from "@/server/vapi/http";
import { payloadOf, post, testDb, testDeps, testSettings, toolCallsBody } from "./helpers";

const baseArgs = {
  issue_type: "maintenance",
  gas_smell: false,
  co_alarm: false,
  burning_smell_or_smoke: false,
  vulnerable_occupants: [],
  property_type: "residential",
  zip: "11372",
};

async function triage(args: Record<string, unknown>, opts: { callId?: string; transfer?: boolean } = {}) {
  const res = await handleToolsRequest(
    post(
      "/api/vapi/tools",
      toolCallsBody({
        callId: opts.callId ?? `call-${randomUUID()}`,
        callerNumber: "+17185550188",
        calls: [{ id: "t", name: "triage_issue", arguments: { ...baseArgs, ...args } }],
      }),
    ),
    testDeps({ settings: testSettings({ transferAvailable: opts.transfer ?? false }) }),
  );
  const { results } = (await res.json()) as { results: Array<{ result?: string; error?: string }> };
  return payloadOf(results[0]);
}

describe("triage_issue tool", () => {
  it("routine path returns up to 3 offered slots in the caller's county in one call", async () => {
    const out = await triage({});
    expect(out).toMatchObject({ ok: true, urgency: "routine", next_action: "book_standard", county: "Queens" });
    const slots = out.offered_slots as Array<{ slot_id: string; starts_at: string; label: string }>;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    for (const s of slots) expect(new Date(s.starts_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("safety stop records a dispatch_request and says emergency services were NOT contacted", async () => {
    const callId = `call-${randomUUID()}`;
    const out = await triage({ gas_smell: true }, { callId });
    expect(out).toMatchObject({ ok: true, urgency: "safety_stop", next_action: "safety_instructions", office_followup_recorded: true });
    expect(out).not.toHaveProperty("offered_slots");
    expect(out.say).toMatch(/has NOT contacted 911/);

    // Different args, same call → still one safety_stop record.
    await triage({ gas_smell: true, co_alarm: true }, { callId });
    const rows = await testDb()
      .select()
      .from(dispatchRequests)
      .where(and(eq(dispatchRequests.vapiCallId, callId), eq(dispatchRequests.urgency, "safety_stop")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", callerPhone: "+17185550188", reasons: ["Caller reports a gas smell"] });
  });

  it("emergency → priority_dispatch, offering transfer only when configured", async () => {
    const args = { issue_type: "no_heat", indoor_temp_f: 50 };
    expect(await triage(args)).toMatchObject({ urgency: "emergency", next_action: "priority_dispatch", offer_transfer: false });
    expect(await triage(args, { transfer: true })).toMatchObject({ offer_transfer: true });
  });

  it("out of area and commercial close without slots", async () => {
    expect(await triage({ zip: "10025" })).toMatchObject({ serviceable: false, not_serviceable_reason: "out_of_area", next_action: "explain_and_close" });
    expect(await triage({ property_type: "commercial", zip: "11201" })).toMatchObject({ not_serviceable_reason: "residential_only" });
  });

  it("missing flags are named", async () => {
    const res = await handleToolsRequest(
      post("/api/vapi/tools", toolCallsBody({ callId: `call-${randomUUID()}`, calls: [{ id: "t", name: "triage_issue", arguments: { issue_type: "no_heat" } }] })),
      testDeps(),
    );
    const out = payloadOf(((await res.json()) as { results: Array<{ error?: string }> }).results[0]);
    expect(out.message).toBe("Missing: gas_smell, co_alarm, burning_smell_or_smoke, property_type, zip");
  });
});
