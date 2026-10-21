import { getDbFor } from "@/server/db/client";
import { createRepositories } from "@/server/repositories";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
import type { VapiHttpDeps } from "@/server/vapi/http";
import type { ToolSettings } from "@/server/vapi/types";
import { testDatabaseUrl } from "./test-db-url";

export const TEST_SECRET = "test-vapi-secret-0123456789";

export const testDb = () => getDbFor(testDatabaseUrl());
export const testRepos = () => createRepositories(testDb());

export const testSettings = (overrides: Partial<ToolSettings> = {}): ToolSettings => ({
  timeZone: "America/New_York",
  transferAvailable: false,
  demoCallerMap: new Map(),
  ...overrides,
});

export const testDeps = (overrides: Partial<VapiHttpDeps> = {}): VapiHttpDeps => ({
  secret: TEST_SECRET,
  repos: testRepos,
  registry: TOOL_REGISTRY,
  settings: testSettings(),
  ...overrides,
});

type ToolCallSpec = { id: string; name: string; arguments: unknown };

/** A Vapi "tool-calls" body, per https://docs.vapi.ai/tools/custom-tools. */
export function toolCallsBody(opts: { callId?: string; callerNumber?: string; calls: ToolCallSpec[] }) {
  return {
    message: {
      type: "tool-calls",
      timestamp: Date.now(),
      call: {
        id: opts.callId,
        type: "inboundPhoneCall",
        ...(opts.callerNumber ? { customer: { number: opts.callerNumber } } : {}),
      },
      toolCallList: opts.calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    },
  };
}

export function post(path: string, body: unknown, authorization: string | null = `Bearer ${TEST_SECRET}`) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Parse one Vapi results[] entry back into its JSON payload. */
export function payloadOf(entry: { result?: string; error?: string }) {
  return JSON.parse((entry.result ?? entry.error) as string) as Record<string, unknown>;
}

/** Run one tool call through the real HTTP handler; returns the parsed payload and raw entry. */
export async function callTool(
  name: string,
  args: unknown,
  opts: { callId?: string; callerNumber?: string; deps?: Partial<VapiHttpDeps> } = {},
) {
  const { handleToolsRequest } = await import("@/server/vapi/http");
  const res = await handleToolsRequest(
    post(
      "/api/vapi/tools",
      toolCallsBody({
        callId: opts.callId ?? `call-${crypto.randomUUID()}`,
        callerNumber: opts.callerNumber,
        calls: [{ id: "t", name, arguments: args }],
      }),
    ),
    testDeps(opts.deps),
  );
  const { results } = (await res.json()) as { results: Array<{ toolCallId: string; result?: string; error?: string }> };
  return { entry: results[0], payload: payloadOf(results[0]) };
}
