import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCallerContext, getCallerContext } from "@/server/services/caller-context";
import { handleToolsRequest } from "@/server/vapi/http";
import { payloadOf, post, testDeps, testRepos, toolCallsBody } from "./helpers";

describe("getCallerContext (real DB)", () => {
  it("active member with equipment", async () => {
    const { context, dbMs } = await getCallerContext("+17185550101", testRepos().customers);
    expect(context).toMatchObject({
      found: true,
      firstName: "Dana",
      isActiveMember: true,
      membership: { status: "active", planName: "Comfort Club Plus" },
    });
    if (!context.found) throw new Error("unreachable");
    expect(context.addresses).toHaveLength(1);
    expect(context.equipmentSummary).toBe("boiler (Burnham, 2009), ductless mini-split (Mitsubishi, 2021)");
    expect(dbMs).toBeLessThan(300);
  });

  it("non-member in an apartment building", async () => {
    const { context } = await getCallerContext("+19175550104", testRepos().customers);
    expect(context).toMatchObject({ found: true, firstName: "Lena", membership: null, isActiveMember: false });
    if (!context.found) throw new Error("unreachable");
    expect(context.addresses[0]).toMatchObject({ line1: "1450 Ocean Ave", unit: "5C" });
    expect(context.addresses[0].accessNotes).toContain("super");
  });

  it("lapsed member is not an active member", async () => {
    const { context } = await getCallerContext("+17185550103", testRepos().customers);
    expect(context).toMatchObject({ found: true, isActiveMember: false, membership: { status: "lapsed" } });
  });

  it("unknown number", async () => {
    const { context } = await getCallerContext("+17185550199", testRepos().customers);
    expect(context).toEqual({ found: false, phoneE164: "+17185550199" });
  });

  it("pure: refuses rows for a different number", () => {
    const rows = {
      customer: { id: "x", firstName: "A", lastName: "B", phoneE164: "+17185550101" },
      memberships: [],
      addresses: [],
    };
    expect(buildCallerContext("+17185550102", rows)).toEqual({ found: false, phoneE164: "+17185550102" });
  });
});

describe("lookup_customer tool", () => {
  async function lookup(args: unknown, callerNumber?: string) {
    const res = await handleToolsRequest(
      post(
        "/api/vapi/tools",
        toolCallsBody({ callId: `call-${randomUUID()}`, callerNumber, calls: [{ id: "t", name: "lookup_customer", arguments: args }] }),
      ),
      testDeps(),
    );
    const { results } = (await res.json()) as { results: Array<{ result?: string; error?: string }> };
    return payloadOf(results[0]);
  }

  it("defaults to the caller's number and returns only confirmation fields", async () => {
    const out = await lookup({}, "+13475550102");
    expect(out).toEqual({
      ok: true,
      found: true,
      phone_e164: "+13475550102",
      first_name: "Priya",
      is_member: true,
      membership: { status: "active", plan: "Comfort Club" },
      addresses: [{ line1: "37-12 82nd St", unit: null, zip: "11372" }],
      equipment_summary: "furnace (Carrier, 2012), central AC (Carrier, 2012)", // enum order: heating first
      say: expect.any(String),
    });
    // No last name, email, city, access notes or internal ids leak to the agent.
    const text = JSON.stringify(out);
    for (const leaked of ["Marlowe", "example.com", "Jackson Heights", "driveway", "00000000-"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("explicit phone overrides caller ID and is normalized", async () => {
    const out = await lookup({ phone: "(718) 555-0109" }, "+13475550102");
    expect(out).toMatchObject({ found: true, phone_e164: "+17185550109", first_name: "Grace" });
    expect(out.addresses).toHaveLength(2);
    expect(out.equipment_summary).toContain("108-20 71st Ave:");
  });

  it("non-member", async () => {
    expect(await lookup({ phone: "917-555-0111" })).toMatchObject({ found: true, first_name: "Wen", is_member: false, membership: null });
  });

  it("unknown number returns found:false", async () => {
    expect(await lookup({}, "+17185550188")).toMatchObject({ ok: true, found: false, phone_e164: "+17185550188" });
  });

  it("errors when no phone and no caller ID", async () => {
    expect(await lookup({})).toMatchObject({ ok: false, error_code: "missing_phone" });
  });

  it("errors with the field name when the phone is invalid", async () => {
    const out = await lookup({ phone: "555-0101" });
    expect(out).toMatchObject({ ok: false, error_code: "invalid_arguments" });
    expect(out.invalid_fields).toEqual([{ field: "phone", problem: "not a valid phone number" }]);
  });
});
