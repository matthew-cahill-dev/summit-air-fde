import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { callbackRequests, dispatchRequests } from "@/server/db/schema";
import { callTool, testDb } from "./helpers";

const dispatchArgs = {
  first_name: "Robin",
  last_name: "Example",
  address: { line1: "37-12 82nd St", zip: "11372", access_notes: "Side door" },
  issue_type: "no_heat",
  issue_summary: "No heat since last night; 52 degrees inside",
  symptoms: ["furnace won't ignite"],
  vulnerable_occupants: ["infant"],
  indoor_temp_f: 52,
  reasons: ["No heat with indoor temperature 52°F (at or below 55°F)"],
};

describe("create_priority_dispatch", () => {
  it("creates one open emergency dispatch per call and states the callback policy without claiming a tech is en route", async () => {
    const callId = `call-${randomUUID()}`;
    const first = await callTool("create_priority_dispatch", dispatchArgs, { callId, callerNumber: "+17185550401" });
    expect(first.payload).toMatchObject({ ok: true, status: "open", callback_sla_minutes: 15, callback_phone: "+17185550401" });
    expect(first.payload.say).toMatch(/policy is for the on-call team to call them back within 15 minutes/);
    expect(first.payload.say).toMatch(/Do NOT say a technician is assigned/);

    const again = await callTool("create_priority_dispatch", { ...dispatchArgs, issue_summary: "Still no heat" }, { callId, callerNumber: "+17185550401" });
    expect(again.payload.dispatch_id).toBe(first.payload.dispatch_id);

    const rows = await testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgency: "emergency", status: "open", callerName: "Robin Example", reasons: dispatchArgs.reasons });
    expect(rows[0].intake).toMatchObject({ vulnerable_occupants: ["infant"], indoor_temp_f: 52 });
  });

  it("fails open (live call 01a15feb): no reasons are filled in, and no callback number still logs it, then asks only for the number", async () => {
    const { payload } = await callTool("create_priority_dispatch", { ...dispatchArgs, reasons: [] }, { callerNumber: "+17185550403" });
    expect(payload).toMatchObject({ ok: true, status: "open" });
    const noPhone = await callTool("create_priority_dispatch", dispatchArgs);
    expect(noPhone.payload).toMatchObject({ ok: true, status: "open", callback_phone: null });
    expect(noPhone.payload.say).toMatch(/ask only for the best number for the on-call team to call back/);
  });
});

describe("create_callback_request", () => {
  it("records an open callback with context", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool(
      "create_callback_request",
      { reason: "backend_failure", details: "Booking failed twice", caller_name: "Robin", context: { slot_label: "Thursday 8 to 11" } },
      { callId, callerNumber: "(718) 555-0402" },
    );
    expect(payload).toMatchObject({ ok: true, status: "open", callback_phone: "+17185550402" });
    expect(payload.say).toContain("office hours");
    const [row] = await testDb().select().from(callbackRequests).where(eq(callbackRequests.vapiCallId, callId));
    expect(row).toMatchObject({ reason: "backend_failure", callerName: "Robin", status: "open" });
    expect(row.context).toEqual({ details: "Booking failed twice", slot_label: "Thursday 8 to 11" });
  });
});
