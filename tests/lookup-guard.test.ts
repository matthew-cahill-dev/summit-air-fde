// Live call 01a15f31 (Oct 21): lookup_customer never ran. Ava asked for the address, "house or
// apartment?" and the ZIP, triaged and booked Priya (an active member) as a new customer.
// Requirement (c) is now enforced by the backend: see src/server/services/lookup-guard.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appointments } from "@/server/db/schema";
import { LOOKUP_REQUIRED_SAY } from "@/server/services/lookup-guard";
import { formatIdentity, identityOf, type JsonObject } from "@/vapi-sync/call-report";
import { renderSystemPrompt } from "@/vapi-sync/render";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";

const makeSlot = slotFactory(9);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { noLookup: true, ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const PRIYA = { phone: "+13475550102", customer_id: "00000000-0000-4000-8000-000000000002", address_id: "00000000-0000-4000-8001-000000000002" };
const triageArgs = {
  issue_type: "no_cooling",
  gas_smell: false,
  co_alarm: false,
  burning_smell_or_smoke: false,
  vulnerable_occupants: ["elderly"],
  property_type: "residential",
  zip: "11372",
};

describe("lookup_customer must run before triage or an unverified booking (live call 01a15f31)", () => {
  it("replays the live call order: triage first is refused, lookup verifies Priya, then the same triage and a member booking go through", async () => {
    const callId = `call-${randomUUID()}`;
    const opts = { callId, callerNumber: PRIYA.phone };

    // What the model did live: address, house/apartment, ZIP, then straight to triage.
    const first = await callTool("triage_issue", triageArgs, opts);
    expect(first.payload).toMatchObject({ ok: false, error_code: "lookup_required", say: LOOKUP_REQUIRED_SAY });
    expect(first.payload.offered_slots).toBeUndefined();

    // ... and then an unverified booking.
    const slot = await makeSlot({ county: "Queens", capacity: 3, booked: 0 });
    const newCustomerBooking = {
      slot_id: slot.id,
      caller_confirmed: true,
      first_name: "Priya",
      last_name: "Marlowe-Venn",
      address: { line1: "37-12 82nd St", zip: "11372" },
      service_type: "diagnostic",
      urgency: "urgent",
      issue_summary: "AC stopped working, elderly grandmother at home",
    };
    const blockedBooking = await callTool("book_appointment", newCustomerBooking, opts);
    expect(blockedBooking.payload).toMatchObject({ ok: false, error_code: "lookup_required" });
    expect(await testDb().select().from(appointments).where(eq(appointments.vapiCallId, callId))).toHaveLength(0);

    // Following the say: lookup by caller ID, then the street.
    const lookup = await callTool("lookup_customer", {}, opts);
    expect(lookup.payload).toMatchObject({ ok: true, verification_required: true });
    const verified = await callTool("lookup_customer", { street_address: "thirty seven twelve eighty second street" }, opts);
    expect(verified.payload).toMatchObject({ verified: true, is_member: true, customer_id: PRIYA.customer_id });

    // The identical triage call now runs (the refusal isn't replayed by the idempotency layer).
    const again = await callTool("triage_issue", { ...triageArgs, customer_id: PRIYA.customer_id }, opts);
    expect(again.payload).toMatchObject({ ok: true, next_action: "book_earliest" });
    const sameArgs = await callTool("triage_issue", triageArgs, opts);
    expect(sameArgs.payload).toMatchObject({ ok: true });

    const booked = await callTool(
      "book_appointment",
      { ...newCustomerBooking, first_name: undefined, last_name: undefined, address: undefined, customer_id: PRIYA.customer_id, address_id: PRIYA.address_id },
      opts,
    );
    expect(booked.payload).toMatchObject({ ok: true, booked: true, new_customer: false, customer_id: PRIYA.customer_id });
  });

  it("commercial callers and safety calls are never blocked", async () => {
    const opts = () => ({ callId: `call-${randomUUID()}`, callerNumber: "+17185550901" });
    const commercial = await callTool("triage_issue", { ...triageArgs, property_type: "commercial" }, opts());
    expect(commercial.payload).toMatchObject({ ok: true, next_action: "explain_and_close" });
    for (const flag of ["gas_smell", "co_alarm", "burning_smell_or_smoke", "co_symptoms"]) {
      const out = await callTool("triage_issue", { ...triageArgs, [flag]: true }, opts());
      expect(out.payload, flag).toMatchObject({ ok: true, next_action: "safety_instructions" });
    }
    const medical = await callTool("triage_issue", { ...triageArgs, medical_emergency: true }, opts());
    expect(medical.payload).toMatchObject({ ok: true, next_action: "priority_dispatch" });
  });

  it("a lookup with any outcome counts (no account, no caller ID): new callers aren't stuck", async () => {
    const callId = `call-${randomUUID()}`;
    const none = await callTool("lookup_customer", {}, { callId, callerNumber: "+12125550188" });
    expect(none.payload).toMatchObject({ ok: true, found: false });
    const out = await callTool("triage_issue", { ...triageArgs, zip: "10024" }, { callId, callerNumber: "+12125550188" });
    expect(out.payload).toMatchObject({ ok: true });
  });

  it("the prompt says it explicitly, and a lookup_required result isn't a tool failure", () => {
    const p = renderSystemPrompt(readFileSync(join(process.cwd(), "vapi/system-prompt.md"), "utf8"), { transferAvailable: false, timeZone: "America/New_York" });
    expect(p).toContain("3. Right after the safety screen, call lookup_customer with no arguments (caller ID) before asking anything else.");
    expect(p).toContain("ok false with invalid_fields or error_code lookup_required: not a failure.");
  });

  it("call-report's first line says whether lookup_customer ran and the caller was verified", () => {
    const msgs = (tools: Array<[string, string]>): JsonObject[] =>
      tools.flatMap(([name, result], i) => [
        { role: "tool_calls", toolCalls: [{ id: `t${i}`, function: { name } }] },
        { role: "tool_call_result", toolCallId: `t${i}`, result },
      ]);
    // 01a15f31: triage and booking, no lookup.
    const live = identityOf(msgs([["triage_issue", "{}"], ["book_appointment", "{}"]]));
    expect(live).toEqual({ lookups: 0, verified: false, member: null, triagedBeforeLookup: true });
    expect(formatIdentity(live)).toBe("  ⚠ Identity: lookup_customer NEVER ran (membership not checked); triage_issue ran without it");
    const good = identityOf(msgs([["lookup_customer", '{"ok":true,"verification_required":true}'], ["lookup_customer", '{"ok":true,"verified":true,"is_member":true}'], ["triage_issue", "{}"]]));
    expect(formatIdentity(good)).toBe("  Identity: lookup_customer ran 2x; caller verified (active member)");
    expect(formatIdentity(identityOf(msgs([["lookup_customer", '{"ok":true,"found":false}']])))).toBe("  Identity: lookup_customer ran 1x; caller NOT verified");
  });
});
