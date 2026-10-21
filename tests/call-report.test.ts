import { describe, expect, it } from "vitest";
import { parseEndOfCallReport } from "@/server/vapi/events";
import { buildCallReport, buildTurns, formatCallReport, percentile, responseLatency } from "@/vapi-sync/call-report";

const T0 = 1_792_561_736_000; // epoch ms
const at = (s: number) => T0 + s * 1000;

// Shaped like GET /call/{id} artifact.messages (roles, epoch-ms time/endTime, toolCalls/toolCallId).
const messages = [
  { role: "system", message: "prompt", time: at(0), secondsFromStart: 0 },
  { role: "bot", message: "Hi, thanks for calling Summit Air!", time: at(0.5), endTime: at(3), secondsFromStart: 0.5 },
  { role: "user", message: "My AC stopped working.", time: at(4), endTime: at(6), secondsFromStart: 4 },
  { role: "bot", message: "Oh no. Before anything else, do you smell gas?", time: at(7.2), endTime: at(10), secondsFromStart: 7.2 },
  { role: "user", message: "No.", time: at(11), endTime: at(11.4), secondsFromStart: 11 },
  { role: "tool_calls", toolCalls: [{ id: "tc1", type: "function", function: { name: "lookup_customer", arguments: "{}" } }], time: at(12), secondsFromStart: 12 },
  { role: "bot", message: "One sec, let me pull up your account.", time: at(12.1), endTime: at(13.5), secondsFromStart: 12.1 },
  { role: "tool_call_result", toolCallId: "tc1", name: "lookup_customer", result: "{}", time: at(12.31), secondsFromStart: 12.31 },
  { role: "user", message: "It's thirty-seven", time: at(14), endTime: at(15), secondsFromStart: 14 },
  { role: "user", message: "twelve eighty-second street.", time: at(15.3), endTime: at(16.5), secondsFromStart: 15.3 },
  { role: "bot", message: "Perfect.", time: at(16.0), endTime: at(16.6), secondsFromStart: 16 }, // barged in early: overlap
  { role: "user", message: "Bye.", time: at(18), duration: 0.4, secondsFromStart: 18 },
  { role: "bot", message: "Thanks for calling Summit Air. Take care, and goodbye for now.", time: at(19.4), endTime: at(22), secondsFromStart: 19.4 },
];

describe("call-report: per-turn caller stop → assistant start", () => {
  it("groups caller fragments, times tools, and flags overlaps", () => {
    const turns = buildTurns(messages);
    expect(turns.map((t) => [t.callerText, t.gapMs])).toEqual([
      ["My AC stopped working.", 1200],
      ["No.", 700], // the filler counts: the caller heard something after 0.7 s
      ["It's thirty-seven twelve eighty-second street.", -500],
      ["Bye.", 1000], // end from time + duration (seconds)
    ]);
    expect(turns[1].tools).toEqual([{ name: "lookup_customer", ms: 310 }]);
  });

  it("summarizes waits (p50/p95) without letting overlaps pull them down", () => {
    const r = buildCallReport({
      id: "call-1",
      startedAt: new Date(at(0)).toISOString(),
      endedAt: new Date(at(22)).toISOString(),
      endedReason: "assistant-ended-call",
      artifact: {
        messages,
        recordingUrl: "https://example.invalid/rec.wav",
        performanceMetrics: {
          turnLatencies: [{ modelLatency: 500, voiceLatency: 230, transcriberLatency: 300, endpointingLatency: 100, turnLatency: 1130 }],
          endpointingLatencyAverage: 100,
          numAssistantInterrupted: 1,
        },
      },
    });
    expect(r.summary.all).toEqual({ n: 3, p50: 1000, p95: 1200, max: 1200 });
    expect(r.summary.overlaps).toBe(1);
    expect(r.summary.withTools.n).toBe(1);
    expect(r).toMatchObject({ durationSec: 22, endedReason: "assistant-ended-call", recordingUrl: "https://example.invalid/rec.wav" });
    expect(r.lastAssistantMessage).toBe("Thanks for calling Summit Air. Take care, and goodbye for now.");
    expect(r.vapiLatencies[0]).toEqual({ modelMs: 500, voiceMs: 230, transcriberMs: 300, endpointingMs: 100, turnMs: 1130 });
    const text = formatCallReport(r);
    expect(text).toContain("p50=1000ms p95=1200ms");
    expect(text).toContain("lookup_customer 310ms");
    expect(text).toContain("overlaps 1");
  });

  it("percentile is nearest-rank and ignores non-finite values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([3, NaN, 1], 50)).toBe(1);
  });

  it("tolerates missing fields", () => {
    expect(buildTurns([{ role: "user", message: "hi" }])).toEqual([{ index: 1, callerText: "hi", assistantText: "", gapMs: null, tools: [] }]);
    expect(responseLatency(undefined)).toEqual({ p50: null, p95: null, turns: 0 });
    expect(buildCallReport({ id: "x" }).summary.all.n).toBe(0);
  });

  it("the end-of-call report stores the call's response p50/p95 for the console", () => {
    const report = parseEndOfCallReport({
      message: { type: "end-of-call-report", call: { id: "call-latency" }, artifact: { messages } },
    });
    expect(report).toMatchObject({ vapiCallId: "call-latency", responseP50Ms: 1000, responseP95Ms: 1200, responseTurns: 3 });
    const none = parseEndOfCallReport({ message: { type: "end-of-call-report", call: { id: "call-empty" } } });
    expect(none).toMatchObject({ responseP50Ms: null, responseP95Ms: null, responseTurns: null });
  });
});

describe("dashboard latency: stored per call, shown on call detail and the Overview KPI (real DB)", () => {
  it("upserts p50/p95 from the report, keeps them on a sparser re-send, and aggregates today's calls", async () => {
    const { createConsoleRepository } = await import("@/server/repositories/console");
    const { testDb, testRepos } = await import("./helpers");
    const repos = testRepos();
    const now = new Date();
    const id = `call-latency-${crypto.randomUUID()}`;
    await repos.calls.upsertEndOfCallReport({
      vapiCallId: id,
      callerPhone: null,
      startedAt: now,
      endedAt: now,
      endedReason: "assistant-ended-call",
      summary: null,
      transcript: null,
      rawReport: {},
      responseP50Ms: 900,
      responseP95Ms: 1700,
      responseTurns: 12,
    });
    // A later, sparser report (no messages) doesn't wipe the numbers.
    await repos.calls.upsertEndOfCallReport({ vapiCallId: id, callerPhone: null, startedAt: null, endedAt: null, endedReason: null, summary: null, transcript: null, rawReport: {} });

    const repo = createConsoleRepository(testDb());
    expect(await repo.call(id)).toMatchObject({ responseP50Ms: 900, responseP95Ms: 1700, responseTurns: 12 });

    const day = { from: new Date(now.getTime() - 60_000), to: new Date(now.getTime() + 60_000) };
    const rows = await repo.recentCalls({ includeSeed: false, since: day.from, limit: 500 });
    expect(rows.find((r) => r.vapiCallId === id)?.responseP50Ms).toBe(900);
    const { todayMetrics, callTime } = await import("@/server/console/metrics");
    const m = todayMetrics({
      calls: rows.map((r) => ({ at: callTime(r), outcome: "incomplete" as const, status: "ended" as const, responseP50Ms: r.responseP50Ms ?? null })),
      board: [],
      bookingsToday: 0,
      toolRows: [],
      window: day,
    });
    expect(m.respondedCalls).toBeGreaterThanOrEqual(1);
    expect(m.medianResponseMs).not.toBeNull();
  });

  it("formatSeconds reads naturally", async () => {
    const { formatSeconds } = await import("@/server/console/format");
    expect(formatSeconds(null)).toBe("-");
    expect(formatSeconds(640)).toBe("0.64 s");
    expect(formatSeconds(1234)).toBe("1.2 s");
  });
});
