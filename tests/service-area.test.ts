import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateServiceArea } from "@/server/services/check-service-area";
import { handleToolsRequest } from "@/server/vapi/http";
import { payloadOf, post, testDeps, toolCallsBody } from "./helpers";

async function checkArea(args: unknown) {
  const res = await handleToolsRequest(
    post("/api/vapi/tools", toolCallsBody({ callId: `call-${randomUUID()}`, calls: [{ id: "t", name: "check_service_area", arguments: args }] })),
    testDeps(),
  );
  const { results } = (await res.json()) as { results: Array<{ result?: string; error?: string }> };
  return payloadOf(results[0]);
}

describe("check_service_area", () => {
  it("residential, in area (Queens, ZIP+4 accepted)", async () => {
    expect(await checkArea({ zip: "11372-1234", property_type: "residential" })).toMatchObject({
      ok: true,
      zip: "11372",
      in_area: true,
      county: "Queens",
      serviceable: true,
    });
  });

  it("defaults to residential when property_type is omitted (Manhattan is in area)", async () => {
    expect(await checkArea({ zip: "10024" })).toMatchObject({ in_area: true, coverage: "in_area", county: "New York", serviceable: true });
  });

  it("Bronx and Staten Island are a coverage check, never 'we don't serve you'", async () => {
    for (const [zip, borough] of [["10314", "Staten Island"], ["10463", "Bronx"]]) {
      const out = await checkArea({ zip });
      expect(out).toMatchObject({ ok: true, in_area: false, coverage: "coverage_check", serviceable: false, reason: "coverage_unconfirmed", borough });
      expect(out.say).toContain("Let me have our office confirm whether we can cover that address.");
      // Smoke run 50e283bc: the agent used this instead of triage and never asked what was wrong.
      expect(out.say).toContain("this check doesn't replace triage");
      expect(out.say).toContain("then call triage_issue, which gives the coverage-check callback details");
    }
  });

  it("commercial is not serviceable: residential_only", async () => {
    expect(await checkArea({ zip: "11201", property_type: "commercial" })).toMatchObject({
      ok: true,
      in_area: true,
      county: "Kings",
      serviceable: false,
      reason: "residential_only",
    });
  });

  it("out of area (outside NYC: Hoboken, NJ)", async () => {
    expect(await checkArea({ zip: "07030" })).toMatchObject({
      ok: true,
      in_area: false,
      county: null,
      serviceable: false,
      reason: "out_of_area",
    });
  });

  it("pure: inactive ZIP counts as out of area", () => {
    const out = evaluateServiceArea("11215", { county: "Kings", active: false }, "residential");
    expect(out).toMatchObject({ ok: true, data: { in_area: false, reason: "out_of_area" } });
  });
});
