import { getDbFor } from "@/server/db/client";
import { appointmentSlots } from "@/server/db/schema";
import { addDays, dayOfWeek, nextBusinessDays, todayInZone, zonedTimeToUtc } from "@/server/lib/time";
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

/** Record that lookup_customer ran on this call (what the model does first on every home call). */
export async function recordLookup(callId: string) {
  await testRepos().toolInvocations.record({
    idempotencyKey: `${callId}:lookup_customer:test-setup`,
    vapiCallId: callId,
    toolName: "lookup_customer",
    args: {},
    ok: true,
    result: { ok: true, found: false, verified: false, say: "test setup" },
    latencyMs: 0,
  });
}

/** Run one tool call through the real HTTP handler; returns the parsed payload and raw entry. */
export async function callTool(
  name: string,
  args: unknown,
  opts: { callId?: string; callerNumber?: string; deps?: Partial<VapiHttpDeps>; noLookup?: boolean } = {},
) {
  const { handleToolsRequest } = await import("@/server/vapi/http");
  const callId = opts.callId ?? `call-${crypto.randomUUID()}`;
  // triage_issue and unverified book_appointment require lookup_customer earlier in the call
  // (lookup-guard.ts). Tests of other behavior start from a call where it ran; noLookup opts out.
  if (!opts.noLookup && (name === "triage_issue" || name === "book_appointment")) await recordLookup(callId);
  const res = await handleToolsRequest(
    post(
      "/api/vapi/tools",
      toolCallsBody({
        callId,
        callerNumber: opts.callerNumber,
        calls: [{ id: "t", name, arguments: args }],
      }),
    ),
    testDeps(opts.deps),
  );
  const { results } = (await res.json()) as { results: Array<{ toolCallId: string; result?: string; error?: string }> };
  return { entry: results[0], payload: payloadOf(results[0]) };
}

// ---------------------------------------------------------------------------
// Deterministic slots. Test windows sit on fixed weekdays of the first full week the
// seed covers (it seeds the next 10 business days), and tests that book or list them
// pin the clock to that Monday at 06:00. No random offsets, never a weekend, so results
// don't depend on when the suite runs.

const TZ = "America/New_York";
const HOUR = 3_600_000;
const ANCHOR_MONDAY = nextBusinessDays(todayInZone(TZ), 10).find((d) => dayOfWeek(d) === 1)!;

/** Monday 06:00 New York of the anchor week. Pass as `deps: { now: () => TEST_NOW }`. */
export const TEST_NOW = zonedTimeToUtc(ANCHOR_MONDAY, 6, 0, TZ);

const WEEKDAY_OFFSET = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4 } as const;
export type TestWeekday = keyof typeof WEEKDAY_OFFSET;

/**
 * Dedicated slots so tests don't depend on (or disturb) seeded availability.
 * `series` is unique per test file (1, 2, 3, ...): each file gets its own start hour
 * (14 + series), and each slot the next minute, so (county, starts_at) never collides.
 * Thursday (the default) is 81+ hours after TEST_NOW, outside the 48h member-priority window;
 * Tuesday is inside it.
 */
export function slotFactory(series: number) {
  let minute = 0;
  return async (opts: { county?: string; day?: TestWeekday; capacity: number; booked: number }) => {
    if (minute >= 60) throw new Error("slotFactory: more than 60 slots in one file; use another series");
    const startsAt = zonedTimeToUtc(addDays(ANCHOR_MONDAY, WEEKDAY_OFFSET[opts.day ?? "thursday"]), 14 + series, minute++, TZ);
    const [row] = await testDb()
      .insert(appointmentSlots)
      .values({
        county: opts.county ?? "Kings",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
        capacity: opts.capacity,
        booked: opts.booked,
      })
      .returning();
    return row;
  };
}
