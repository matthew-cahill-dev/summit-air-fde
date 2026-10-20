import { describe, expect, it } from "vitest";
import { isAuthorizedBearer } from "@/server/lib/auth";
import { handleEventsRequest, handleToolsRequest } from "@/server/vapi/http";
import { post, testDeps, toolCallsBody, TEST_SECRET } from "./helpers";

describe("isAuthorizedBearer", () => {
  it("accepts the exact bearer secret (case-insensitive scheme)", () => {
    expect(isAuthorizedBearer(`Bearer ${TEST_SECRET}`, TEST_SECRET)).toBe(true);
    expect(isAuthorizedBearer(`bearer ${TEST_SECRET}`, TEST_SECRET)).toBe(true);
  });

  it.each([
    [null],
    [""],
    ["Bearer"],
    ["Bearer "],
    [`Basic ${TEST_SECRET}`],
    [TEST_SECRET],
    [`Bearer ${TEST_SECRET}x`],
    [`Bearer ${TEST_SECRET.slice(0, -1)}`],
  ])("rejects %j", (header) => {
    expect(isAuthorizedBearer(header, TEST_SECRET)).toBe(false);
  });

  it("rejects everything when the configured secret is empty", () => {
    expect(isAuthorizedBearer("Bearer ", "")).toBe(false);
  });
});

describe("auth on Vapi routes", () => {
  const body = toolCallsBody({ callId: "c-auth", calls: [{ id: "t", name: "check_service_area", arguments: { zip: "11215" } }] });

  it.each([[null], ["Bearer wrong-secret"], [`Basic ${TEST_SECRET}`]])("tools returns 401 for %j", async (header) => {
    const res = await handleToolsRequest(post("/api/vapi/tools", body, header), testDeps());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("events returns 401 without the secret", async () => {
    const res = await handleEventsRequest(post("/api/vapi/events", { message: { type: "end-of-call-report" } }, null), testDeps());
    expect(res.status).toBe(401);
  });
});
