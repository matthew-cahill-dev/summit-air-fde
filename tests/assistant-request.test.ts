import { describe, expect, it } from "vitest";
import type { CustomerRepository } from "@/server/repositories";
import { handleAssistantRequest, type AssistantRequestDeps } from "@/server/vapi/assistant-request";
import { post, TEST_SECRET, testRepos } from "./helpers";

const body = (number?: string) => ({
  message: { type: "assistant-request", call: { id: "c1", type: "inboundPhoneCall", ...(number ? { customer: { number } } : {}) } },
});

const deps = (over: Partial<AssistantRequestDeps> = {}): AssistantRequestDeps => ({
  secret: TEST_SECRET,
  enabled: true,
  assistantId: "asst-123",
  customers: () => testRepos().customers,
  demoCallerMap: new Map(),
  ...over,
});

async function ask(b: unknown, d: AssistantRequestDeps, auth?: string | null) {
  const res = await handleAssistantRequest(post("/api/vapi/assistant-request", b, auth), d);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/vapi/assistant-request", () => {
  it("flags recognized callers without sending any account details (they aren't verified yet)", async () => {
    const { status, json } = await ask(body("+17185550109"), deps());
    expect(status).toBe(200);
    expect(json).toEqual({ assistantId: "asst-123", assistantOverrides: { variableValues: { caller_recognized: "yes" } } });
  });

  it("unknown caller, no caller ID, or flag off → plain assistantId", async () => {
    expect((await ask(body("+17185550177"), deps())).json).toEqual({ assistantId: "asst-123" });
    expect((await ask(body(), deps())).json).toEqual({ assistantId: "asst-123" });
    expect((await ask(body("+17185550109"), deps({ enabled: false }))).json).toEqual({ assistantId: "asst-123" });
  });

  it("falls back to the plain assistantId when the lookup misses the deadline or throws", async () => {
    const slow: CustomerRepository = {
      ...testRepos().customers,
      findCallerContextByPhone: () => new Promise((r) => setTimeout(() => r(null), 500)),
    };
    const started = Date.now();
    expect((await ask(body("+17185550109"), deps({ customers: () => slow, deadlineMs: 50 }))).json).toEqual({ assistantId: "asst-123" });
    expect(Date.now() - started).toBeLessThan(400);

    const broken: CustomerRepository = { ...testRepos().customers, findCallerContextByPhone: () => Promise.reject(new Error("db down")) };
    expect((await ask(body("+17185550109"), deps({ customers: () => broken }))).json).toEqual({ assistantId: "asst-123" });
  });

  it("requires the bearer secret", async () => {
    expect((await ask(body("+17185550109"), deps(), null)).status).toBe(401);
  });

  it("without VAPI_ASSISTANT_ID it returns a spoken error rather than an empty answer", async () => {
    expect((await ask(body("+17185550109"), deps({ assistantId: undefined }))).json).toHaveProperty("error");
  });
});
