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

  it("defaults to residential when property_type is omitted", async () => {
    expect(await checkArea({ zip: "10314" })).toMatchObject({ in_area: true, county: "Richmond", serviceable: true });
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

  it("out of area (Manhattan)", async () => {
    expect(await checkArea({ zip: "10025" })).toMatchObject({
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
