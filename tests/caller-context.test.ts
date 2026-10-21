import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customers, serviceAddresses } from "@/server/db/schema";
import { buildCallerContext, getCallerContext } from "@/server/services/caller-context";
import { handleToolsRequest } from "@/server/vapi/http";
import { payloadOf, post, testDb, testDeps, testRepos, testSettings, toolCallsBody } from "./helpers";

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

describe("lookup_customer tool (identity verification)", () => {
  async function lookup(args: unknown, callerNumber?: string, opts: { demoCallerMap?: Map<string, string>; callId?: string } = {}) {
    const res = await handleToolsRequest(
      post(
        "/api/vapi/tools",
        toolCallsBody({
          callId: opts.callId ?? `call-${randomUUID()}`,
          callerNumber,
          calls: [{ id: `t-${randomUUID()}`, name: "lookup_customer", arguments: args }],
        }),
      ),
      testDeps({ settings: testSettings({ demoCallerMap: opts.demoCallerMap ?? new Map() }) }),
    );
    const { results } = (await res.json()) as { results: Array<{ result?: string; error?: string }> };
    return payloadOf(results[0]);
  }

  // Nothing stored may appear in an unverified result.
  const STORED_DETAILS = ["Priya", "Marlowe", "37-12", "82nd", "11372", "Comfort", "Carrier", "00000000-", "example.com", "driveway"];
  const expectNoDisclosure = (out: Record<string, unknown>) => {
    const text = JSON.stringify(out);
    for (const d of STORED_DETAILS) expect(text).not.toContain(d);
  };

  describe("by phone", () => {
    it("caller ID match without a stated address is unverified and discloses nothing", async () => {
      const out = await lookup({}, "+13475550102");
      expect(out).toEqual({ ok: true, found: true, verified: false, verification_required: true, say: expect.stringContaining("street address") });
      expectNoDisclosure(out);
    });

    it.each([["37-12 82nd Street"], ["thirty-seven twelve eighty-second street"], ["3712 82nd St, Jackson Heights"], ["37 12 82 st"]])(
      "verified when the caller says %j",
      async (said) => {
        const out = await lookup({ street_address: said }, "+13475550102");
        expect(out).toMatchObject({
          ok: true,
          verified: true,
          matched_by: "phone",
          customer_id: "00000000-0000-4000-8000-000000000002",
          first_name: "Priya",
          is_member: true,
          membership: { status: "active", plan: "Comfort Club" },
          addresses: [{ address_id: "00000000-0000-4000-8001-000000000002", line1: "37-12 82nd St", unit: null, zip: "11372", access_notes_on_file: true }],
          equipment_summary: "furnace (Carrier, 2012), central AC (Carrier, 2012)",
        });
        expect(JSON.stringify(out)).not.toMatch(/Marlowe|example\.com|driveway/);
      },
    );

    it.each([["37-14 82nd Street"], ["37-12 83rd Street"], ["82nd Street"], ["412 Seventh Ave"]])("wrong address %j → verified:false, nothing disclosed", async (said) => {
      const out = await lookup({ street_address: said }, "+13475550102");
      expect(out).toMatchObject({ ok: true, found: false, verified: false, verification_failed: true });
      expectNoDisclosure(out);
    });

    it("multi-address customers: only the stated address is returned", async () => {
      const out = await lookup({ street_address: "one oh eight twenty seventy first avenue", phone: "(718) 555-0109" });
      expect(out).toMatchObject({ verified: true, first_name: "Grace" });
      expect(out.addresses).toEqual([expect.objectContaining({ line1: "108-20 71st Ave", unit: "6D" })]);
      expect(JSON.stringify(out)).not.toContain("Bayview");
    });

    it("unknown number", async () => {
      expect(await lookup({}, "+17185550188")).toMatchObject({ ok: true, found: false, verified: false });
    });

    it("no phone and no caller ID is a normal not-found, not an error (the prompt treats errors as outages)", async () => {
      expect(await lookup({})).toMatchObject({ ok: true, found: false, verified: false, caller_id_unavailable: true });
    });

    it("errors with the field name when the phone is invalid", async () => {
      const out = await lookup({ phone: "555-0101" });
      expect(out.invalid_fields).toEqual([{ field: "phone", problem: "not a valid phone number" }]);
    });
  });

  describe("by last name + ZIP + caller-stated street", () => {
    it("verifies on an exact match, even without caller ID", async () => {
      const out = await lookup({ last_name: "marlowe-venn", zip: "11372", street_address: "thirty seven twelve eighty second street" });
      expect(out).toMatchObject({ verified: true, matched_by: "name", first_name: "Priya" });
      expect(out).not.toHaveProperty("phone_e164");
    });

    it("shared last name + ZIP is disambiguated by the stated street", async () => {
      const morgan = await lookup({ last_name: "Quillfeather", zip: "11215", street_address: "two eleven prospect park west" });
      expect(morgan).toMatchObject({ verified: true, first_name: "Morgan" });
      expect(JSON.stringify(morgan)).not.toContain("Dana");
      const dana = await lookup({ last_name: "Quillfeather", zip: "11215", street_address: "four twelve seventh avenue" });
      expect(dana).toMatchObject({ verified: true, first_name: "Dana" });
    });

    it("unknown name and wrong street look identical (no enumeration)", async () => {
      const unknownName = await lookup({ last_name: "Nobody", zip: "11215", street_address: "412 Seventh Ave" });
      const wrongStreet = await lookup({ last_name: "Quillfeather", zip: "11215", street_address: "500 Fifth Ave" });
      expect(unknownName).toEqual(wrongStreet);
      expectNoDisclosure(unknownName);
    });

    it("requires street_address with last_name, naming the field", async () => {
      const out = await lookup({ last_name: "Quillfeather" });
      expect(out).toMatchObject({ ok: false, error_code: "invalid_arguments", message: "Missing: street_address" });
    });
  });

  describe("by last name + caller-stated street, ZIP omitted", () => {
    it("verifies and derives the ZIP from the matched address", async () => {
      const out = await lookup({ last_name: "Marlowe-Venn", street_address: "37 12 80 second Street" });
      expect(out).toMatchObject({
        verified: true,
        matched_by: "name",
        first_name: "Priya",
        addresses: [expect.objectContaining({ line1: "37-12 82nd St", zip: "11372" })],
      });
    });

    it("a shared last name is still settled by the street", async () => {
      expect(await lookup({ last_name: "quillfeather", street_address: "four twelve seventh avenue" })).toMatchObject({ verified: true, first_name: "Dana" });
      expect(await lookup({ last_name: "Quillfeather", street_address: "211 Prospect Park West" })).toMatchObject({ verified: true, first_name: "Morgan" });
    });

    it("wrong street without ZIP looks identical to an unknown name", async () => {
      const wrongStreet = await lookup({ last_name: "Marlowe-Venn", street_address: "37-14 82nd St" });
      const unknownName = await lookup({ last_name: "Nobody", street_address: "37-12 82nd St" });
      expect(wrongStreet).toEqual(unknownName);
      expect(wrongStreet).toMatchObject({ verified: false, verification_failed: true });
      expectNoDisclosure(wrongStreet);
    });

    it("same name and street in two ZIPs is ambiguous until the caller gives the ZIP", async () => {
      // A second (fictional) Quillfeather at "412 Seventh Ave" in another Brooklyn ZIP.
      const db = testDb();
      const [twin] = await db
        .insert(customers)
        .values({ firstName: "Robin", lastName: "Quillfeather", phoneE164: "+17185550177", email: null })
        .returning({ id: customers.id });
      await db.insert(serviceAddresses).values({ customerId: twin.id, line1: "412 7th Ave", city: "Brooklyn", zip: "11238", county: "Kings" });
      try {
        const ambiguous = await lookup({ last_name: "Quillfeather", street_address: "412 Seventh Avenue" });
        expect(ambiguous).toEqual({ ok: true, found: false, verified: false, ambiguous: true, needs: "zip", say: expect.stringContaining("ZIP") });
        expect(JSON.stringify(ambiguous)).not.toMatch(/Dana|Robin|11215|11238/);

        expect(await lookup({ last_name: "Quillfeather", street_address: "412 Seventh Avenue", zip: "11215" })).toMatchObject({ verified: true, first_name: "Dana" });
        expect(await lookup({ last_name: "Quillfeather", street_address: "412 Seventh Avenue", zip: "11238" })).toMatchObject({ verified: true, first_name: "Robin" });
      } finally {
        await db.delete(customers).where(eq(customers.id, twin.id));
      }
    });

    it("failed name lookups without ZIP count toward the per-call lockout", async () => {
      const callId = `call-${randomUUID()}`;
      for (const street of ["1 Main St", "2 Main St", "3 Main St"]) {
        expect(await lookup({ last_name: "Marlowe-Venn", street_address: street }, undefined, { callId })).toMatchObject({ verification_failed: true });
      }
      const out = await lookup({ last_name: "Marlowe-Venn", street_address: "37-12 82nd St" }, undefined, { callId });
      expect(out).toMatchObject({ verified: false, verification_locked: true });
      expectNoDisclosure(out);
    });
  });

  it("locks after 3 failed verifications on one call", async () => {
    const callId = `call-${randomUUID()}`;
    for (const street of ["1 Main St", "2 Main St", "3 Main St"]) {
      expect(await lookup({ street_address: street }, "+13475550102", { callId })).toMatchObject({ verification_failed: true });
    }
    // Even the right address no longer verifies on this call.
    const out = await lookup({ street_address: "37-12 82nd St" }, "+13475550102", { callId });
    expect(out).toMatchObject({ verified: false, verification_locked: true });
    expectNoDisclosure(out);
  });

  describe("DEMO_CALLER_PHONES", () => {
    const realPhone = "+12025550100"; // stands in for a tester's real phone
    const demoMap = new Map([[realPhone, "00000000-0000-4000-8000-000000000005"]]);

    it("maps a configured phone to its demo customer, still requiring the street", async () => {
      expect(await lookup({}, realPhone, { demoCallerMap: demoMap })).toMatchObject({ found: true, verified: false });
      const out = await lookup({ street_address: "twenty one forty five thirty first street" }, realPhone, { demoCallerMap: demoMap });
      expect(out).toMatchObject({ verified: true, matched_by: "demo_alias", first_name: "Tomas", phone_e164: realPhone });
      expect(JSON.stringify(out)).not.toContain("+17185550105");
    });
  });
});
