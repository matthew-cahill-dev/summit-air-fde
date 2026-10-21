// Service area (Oct 21, 2026): Brooklyn, Queens and Manhattan are served (an ASSUMPTION to
// confirm); Bronx and Staten Island get an office coverage check and are never booked; anything
// outside NYC is declined politely.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BOROUGH, BUSINESS, coverageOf, NYC_ZIPS } from "@/config/business";
import { callbackItem } from "@/server/console/board";
import { deriveOutcome, summarizeCall } from "@/server/console/outcome";
import { appointments, callbackRequests } from "@/server/db/schema";
import type { BoardCallbackRow, CallActivityRow } from "@/server/repositories";
import { createConsoleRepository } from "@/server/repositories/console";
import { coverageCheckBorough } from "@/server/services/callback-request";
import { triageRules, type TriageFlags } from "@/server/triage/rules";
import { businessFactsText, renderSystemPrompt } from "@/vapi-sync/render";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";

const makeSlot = slotFactory(7);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const triageArgs = (zip: string, over: Record<string, unknown> = {}) => ({
  issue_type: "no_heat",
  gas_smell: false,
  co_alarm: false,
  burning_smell_or_smoke: false,
  property_type: "residential",
  zip,
  ...over,
});
const newCaller = (slotId: string, address: Record<string, unknown>) => ({
  slot_id: slotId,
  caller_confirmed: true,
  first_name: "Ari",
  last_name: "Coverage",
  address,
  service_type: "repair",
  urgency: "routine",
  issue_summary: "No heat in the bedroom",
});

describe("config: the assumed three counties", () => {
  it("serves Kings, Queens and New York; Bronx and Richmond are coverage checks", () => {
    expect(BUSINESS.serviceCounties).toEqual(["Kings", "Queens", "New York"]);
    expect(BUSINESS.coverageCheckCounties).toEqual(["Bronx", "Richmond"]);
    expect(BUSINESS.facts.serviceArea).toBe("Brooklyn, Queens and Manhattan");
    expect(BOROUGH["New York"]).toBe("Manhattan");
    const source = readFileSync(join(process.cwd(), "src/config/business.ts"), "utf8");
    expect(source).toMatch(/ASSUMPTION \(owner to confirm\): Summit Air said "three counties" without naming them/);
  });

  it("knows every residential Manhattan and Bronx ZIP; no ZIP is in two counties", () => {
    expect(NYC_ZIPS["New York"]).toEqual(expect.arrayContaining(["10001", "10024", "10025", "10128", "10280"]));
    expect(NYC_ZIPS.Bronx).toHaveLength(25);
    const all = Object.values(NYC_ZIPS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("coverageOf: active = in area, inactive Bronx/Richmond = coverage check, anything else = out of area", () => {
    expect(coverageOf({ county: "New York", active: true })).toEqual({ coverage: "in_area", county: "New York", borough: "Manhattan" });
    expect(coverageOf({ county: "Richmond", active: false })).toEqual({ coverage: "coverage_check", county: "Richmond", borough: "Staten Island" });
    expect(coverageOf({ county: "Bronx", active: false })).toMatchObject({ coverage: "coverage_check", borough: "Bronx" });
    expect(coverageOf({ county: "Kings", active: false })).toMatchObject({ coverage: "out_of_area" });
    expect(coverageOf(null)).toEqual({ coverage: "out_of_area", county: null, borough: null });
  });

  it("the seed flags the ZIP table that way (re-running it re-flags existing rows)", async () => {
    const rows = await testDb().execute(sql`select county, bool_and(active) as all_active, bool_or(active) as any_active from service_area_zips group by county`);
    const byCounty = Object.fromEntries((rows.rows as Array<{ county: string; all_active: boolean; any_active: boolean }>).map((r) => [r.county, r]));
    for (const c of ["Kings", "Queens", "New York"]) expect(byCounty[c]).toMatchObject({ all_active: true });
    for (const c of ["Bronx", "Richmond"]) expect(byCounty[c]).toMatchObject({ any_active: false });
  });
});

describe("triage rules: three paths", () => {
  const flags = (over: Partial<TriageFlags> = {}): TriageFlags => ({
    issueType: "no_heat",
    gasSmell: false,
    coAlarm: false,
    burningSmellOrSmoke: false,
    vulnerableOccupants: [],
    propertyType: "residential",
    ...over,
  });
  const WINTER = { year: 2026, month: 1, day: 15 };
  const coverage = { zip: "10314", inArea: false, county: null, coverage: "coverage_check" as const, borough: "Staten Island" };

  it("coverage check → office_review at every urgency, never a booking or a dispatch", () => {
    for (const f of [flags({ issueType: "maintenance" }), flags(), flags({ vulnerableOccupants: ["elderly"] })]) {
      const d = triageRules(f, coverage, WINTER);
      expect(d).toMatchObject({ nextAction: "office_review", serviceable: false, notServiceableReason: "coverage_unconfirmed" });
      expect(d.reasons.at(-1)).toBe("Coverage not confirmed for Staten Island: office to confirm");
    }
  });

  it("safety still comes first; a business is still declined", () => {
    expect(triageRules(flags({ gasSmell: true }), coverage, WINTER).nextAction).toBe("safety_instructions");
    expect(triageRules(flags({ propertyType: "commercial" }), coverage, WINTER)).toMatchObject({ nextAction: "explain_and_close", notServiceableReason: "residential_only" });
  });

  it("in area books; outside NYC explains and closes", () => {
    expect(triageRules(flags(), { zip: "10024", inArea: true, county: "New York", coverage: "in_area" }, WINTER).nextAction).toBe("book_earliest");
    expect(triageRules(flags(), { zip: "07030", inArea: false, county: null, coverage: "out_of_area" }, WINTER)).toMatchObject({ nextAction: "explain_and_close", notServiceableReason: "out_of_area" });
  });
});

describe("path 1: Manhattan is booked like any other borough", () => {
  it("triage offers Manhattan windows and a new Upper West Side apartment books", async () => {
    const triage = await callTool("triage_issue", triageArgs("10024", { issue_type: "maintenance" }));
    expect(triage.payload).toMatchObject({ ok: true, next_action: "book_standard", in_area: true, coverage: "in_area", county: "New York" });
    expect((triage.payload.offered_slots as unknown[]).length).toBeGreaterThan(0);

    const slot = await makeSlot({ county: "New York", capacity: 2, booked: 0 });
    const { payload } = await callTool("book_appointment", newCaller(slot.id, { line1: "300 W 86th St", unit: "12A", city: "New York", zip: "10024" }), { callerNumber: "+12125550760" });
    expect(payload).toMatchObject({ ok: true, booked: true });
  });

  it("the Manhattan personas verify by last name and spoken street", async () => {
    const clara = await callTool("lookup_customer", { last_name: "Vandermeer", street_address: "two fifty west eighty-fifth street" });
    expect(clara.payload).toMatchObject({ verified: true, first_name: "Clara", is_member: false, addresses: [{ line1: "250 W 85th St", unit: "7B", zip: "10024", access_notes_on_file: true }] });
    const theo = await callTool("lookup_customer", { last_name: "Ashgrove", street_address: "141 East 19th Street" });
    expect(theo.payload).toMatchObject({ verified: true, first_name: "Theo", is_member: true, membership: { plan: "Comfort Club Plus", status: "active" } });
    expect(theo.payload.equipment_summary).toBe("furnace (Carrier, 2016), central AC (Carrier, 2016)");
  });
});

describe("path 2: Bronx and Staten Island get a coverage check, never a booking", () => {
  it("triage: office_review with the exact callback and wording, no slots", async () => {
    const { payload } = await callTool("triage_issue", triageArgs("10314", { vulnerable_occupants: ["elderly"] }));
    expect(payload).toMatchObject({
      ok: true,
      next_action: "office_review",
      coverage_check: true,
      borough: "Staten Island",
      coverage: "coverage_check",
      serviceable: false,
      not_serviceable_reason: "coverage_unconfirmed",
      callback: { reason: "other", details: "coverage check: Staten Island" },
    });
    expect(payload).not.toHaveProperty("offered_slots");
    expect(payload.say).toContain('Say: "Let me have our office confirm whether we can cover that address."');
    expect(payload.say).toContain("Don't give a reason and don't say we don't serve Staten Island");
    expect(payload.say).toContain("call 911"); // urgent/emergency: health first
  });

  it("availability and booking refuse coverage-check ZIPs, and an address on file there (Marcus, Staten Island)", async () => {
    expect((await callTool("get_availability", { zip: "10463", urgency: "routine" })).payload).toMatchObject({ ok: false, error_code: "coverage_check" });

    const richmond = await makeSlot({ county: "Richmond", capacity: 3, booked: 0 }); // an old Staten Island window still in the table
    const fresh = await callTool("book_appointment", newCaller(richmond.id, { line1: "9 Hylan Blvd", zip: "10305" }), { callerNumber: "+17185550761" });
    expect(fresh.payload).toMatchObject({ ok: false, error_code: "coverage_check", coverage_check: true, borough: "Staten Island" });

    const marcus = await callTool("book_appointment", {
      ...newCaller(richmond.id, {}),
      address: undefined,
      customer_id: "00000000-0000-4000-8000-000000000003",
      address_id: "00000000-0000-4000-8001-000000000003",
    });
    expect(marcus.payload).toMatchObject({ ok: false, error_code: "coverage_check", borough: "Staten Island" });
    expect(await testDb().select().from(appointments).where(eq(appointments.slotId, richmond.id))).toHaveLength(0);
  });

  it("the callback is tagged as a coverage check (from the wording, or from the call's triage ZIP)", async () => {
    const worded = `call-${randomUUID()}`;
    await callTool("create_callback_request", { reason: "other", details: "coverage check: Bronx, 2400 Grand Concourse" }, { callId: worded, callerNumber: "+17185550762" });
    const [a] = await testDb().select().from(callbackRequests).where(eq(callbackRequests.vapiCallId, worded));
    expect(a.context).toMatchObject({ kind: "coverage_check", borough: "Bronx" });

    const unworded = `call-${randomUUID()}`;
    await callTool("triage_issue", triageArgs("10306"), { callId: unworded });
    await callTool("create_callback_request", { reason: "other", details: "Wants someone to come look at the heat" }, { callId: unworded, callerNumber: "+17185550763" });
    const [b] = await testDb().select().from(callbackRequests).where(eq(callbackRequests.vapiCallId, unworded));
    expect(b.context).toMatchObject({ kind: "coverage_check", borough: "Staten Island" });

    expect(coverageCheckBorough("Coverage check - Staten Island. Heat out")).toBe("Staten Island");
    expect(coverageCheckBorough("reschedule Thursday")).toBeNull();
  });
});

describe("path 3: outside NYC is declined politely", () => {
  it("triage explains and closes; booking refuses", async () => {
    const { payload } = await callTool("triage_issue", triageArgs("07030"));
    expect(payload).toMatchObject({ next_action: "explain_and_close", coverage: "out_of_area", not_serviceable_reason: "out_of_area" });
    expect(payload.say).toContain("we only serve Brooklyn, Queens and Manhattan");
    const slot = await makeSlot({ county: "New York", capacity: 2, booked: 0 });
    const book = await callTool("book_appointment", newCaller(slot.id, { line1: "88 River St", zip: "07030" }), { callerNumber: "+12015550764" });
    expect(book.payload).toMatchObject({ ok: false, error_code: "out_of_area" });
  });
});

describe("dashboard: 'Coverage check' is its own outcome", () => {
  it("outranks a plain callback, but not a booking, a dispatch or a safety stop", () => {
    const cov = { context: { kind: "coverage_check", borough: "Bronx" }, status: "open" as const };
    expect(deriveOutcome({ invocations: [], appointments: [], dispatches: [], callbacks: [cov] })).toBe("coverage_check");
    expect(deriveOutcome({ invocations: [{ toolName: "triage_issue", ok: true, result: { not_serviceable_reason: "coverage_unconfirmed" } }], appointments: [], dispatches: [], callbacks: [] })).toBe("coverage_check");
    expect(deriveOutcome({ invocations: [], appointments: [], dispatches: [], callbacks: [{ status: "open" }] })).toBe("callback");
    expect(deriveOutcome({ invocations: [], appointments: [{ status: "confirmed" }], dispatches: [], callbacks: [cov] })).toBe("booked");
  });

  it("board card: 'Confirm coverage · <borough>'", () => {
    const row: BoardCallbackRow = {
      id: "x",
      reason: "other",
      context: { details: "coverage check: Staten Island", kind: "coverage_check", borough: "Staten Island" },
      callerName: "Bea",
      callerPhone: null,
      createdAt: TEST_NOW,
      vapiCallId: null,
      isDemoSeed: false,
      triageUrgency: "urgent",
      triageReasons: [],
      triageArgs: null,
    };
    expect(callbackItem(row, TEST_NOW)).toMatchObject({ title: "Confirm coverage · Staten Island", coverageCheck: "Staten Island" });
  });

  it("the seeded Staten Island call (Bea) shows as a coverage check", async () => {
    const repo = createConsoleRepository(testDb());
    const call = (await repo.call("demo-seed-call-04")) as CallActivityRow;
    expect(summarizeCall(call, await repo.callRecords(["demo-seed-call-04"]), TEST_NOW).outcome).toBe("coverage_check");
  });
});

describe("prompt and business facts", () => {
  const template = readFileSync(join(process.cwd(), "vapi/system-prompt.md"), "utf8");
  const p = renderSystemPrompt(template, { transferAvailable: false, timeZone: "America/New_York" });

  it("states the new area and the coverage-check line, with no invented reason", () => {
    expect(businessFactsText()).toContain("- Service area: homes in Brooklyn, Queens and Manhattan.");
    expect(p).toContain('say: "Let me have our office confirm whether we can cover that address." Give no reason and never say we don\'t serve them.');
    expect(p).not.toMatch(/Staten Island\)? (is|are) (not|outside)/);
  });

  it("gas guidance fits Manhattan: 911 first, Con Edison for Manhattan, National Grid for Brooklyn/most of Queens/Staten Island", () => {
    const safety = p.slice(p.indexOf("# Safety comes first"), p.indexOf("# Call flow"));
    expect(safety.indexOf("call nine one one")).toBeLessThan(safety.indexOf("Con Edison"));
    expect(safety).toContain("Nine one one comes first.");
    expect(safety).toContain("in Manhattan (and the Bronx) it's Con Edison, one eight hundred, seven five two, six six three three");
    expect(safety).toContain("In Brooklyn, most of Queens and Staten Island it's National Grid, seven one eight, six four three, four zero five zero");
  });
});
