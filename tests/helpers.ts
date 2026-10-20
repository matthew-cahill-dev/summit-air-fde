import { getDbFor } from "@/server/db/client";
import { createRepositories } from "@/server/repositories";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
import type { VapiHttpDeps } from "@/server/vapi/http";
import { testDatabaseUrl } from "./test-db-url";

export const TEST_SECRET = "test-vapi-secret-0123456789";

export const testDb = () => getDbFor(testDatabaseUrl());
export const testRepos = () => createRepositories(testDb());

export const testDeps = (): VapiHttpDeps => ({ secret: TEST_SECRET, repos: testRepos, registry: TOOL_REGISTRY });

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
