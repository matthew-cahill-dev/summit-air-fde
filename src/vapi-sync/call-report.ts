// Per-turn latency for one Vapi call, from GET /call/{id}. Pure: the script in
// scripts/call-report.ts fetches; this shapes and summarizes.
// Fields (checked against https://api.vapi.ai/api-json, Oct 2026):
//   artifact.messages[]: { role: "user" | "bot" | "tool_calls" | "tool_call_result" | "system", time, endTime,
//     secondsFromStart, duration, message, toolCalls, toolCallId, name }  (time/endTime are epoch ms)
//   artifact.performanceMetrics: { turnLatencies[]: { modelLatency, voiceLatency, transcriberLatency,
//     endpointingLatency, turnLatency }, *Average, numUserInterrupted, numAssistantInterrupted }
// Keep this file free of path aliases: it is compiled for scripts/call-report.ts.

export type JsonObject = { [key: string]: unknown };

export type ToolTiming = { name: string; ms: number | null };

export type Turn = {
  /** Index of the caller message this turn answers. */
  index: number;
  callerText: string;
  assistantText: string;
  /** Caller stopped speaking (user endTime) → assistant started speaking (bot time), ms. */
  gapMs: number | null;
  tools: ToolTiming[];
};

export type TurnLatencyRow = {
  modelMs: number | null;
  voiceMs: number | null;
  transcriberMs: number | null;
  endpointingMs: number | null;
  turnMs: number | null;
};

export type CallReport = {
  id: string;
  startedAt: string | null;
  endedReason: string | null;
  durationSec: number | null;
  turns: Turn[];
  vapiLatencies: TurnLatencyRow[];
  vapiAverages: Record<string, number | null>;
  /**
   * Vapi's counters (spec): numUserInterrupted = "times the user was interrupted by the assistant"
   * (Ava cut in); numAssistantInterrupted = "times the assistant was interrupted by the user" (barge-in).
   */
  interruptions: { avaCutIn: number | null; callerBargedIn: number | null };
  /** Requirement (c): did lookup_customer run, and was the caller verified? */
  identity: Identity;
  /** Timings from Vapi's per-call log (artifact.presignedLogUrl), when it was fetched. */
  log: LogAnalysis | null;
  /** The real line drop from Vapi's SIP capture (artifact.presignedPcapUrl), when it was fetched. */
  teardown: Teardown | null;
  lastAssistantMessage: string | null;
  recordingUrl: string | null;
  /** Response waits (non-negative gaps only); negative gaps are overlaps (someone barged in). */
  summary: { all: Stats; noTools: Stats; withTools: Stats; overlaps: number };
};

export type Stats = { n: number; p50: number | null; p95: number | null; max: number | null };

export type Identity = { lookups: number; verified: boolean; member: boolean | null; triagedBeforeLookup: boolean };

/** From the transcript's tool calls and results: lookups, verification, and whether triage came first. */
export function identityOf(messages: JsonObject[]): Identity {
  const names = new Map<string, string>();
  let lookups = 0;
  let verified = false;
  let member: boolean | null = null;
  let triagedBeforeLookup = false;
  for (const m of messages) {
    if (m.role === "tool_calls" && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls as JsonObject[]) {
        const name = str(obj(tc.function)?.name) ?? "?";
        names.set(String(tc.id), name);
        if (name === "lookup_customer") lookups++;
        if (name === "triage_issue" && lookups === 0) triagedBeforeLookup = true;
      }
    } else if (m.role === "tool_call_result" && names.get(String(m.toolCallId)) === "lookup_customer") {
      try {
        const r = JSON.parse(String(m.result ?? "{}")) as JsonObject;
        if (r.verified === true) {
          verified = true;
          member = r.is_member === true;
        }
      } catch {
        // Not JSON: an error string.
      }
    }
  }
  return { lookups, verified, member, triagedBeforeLookup };
}

export function formatIdentity(i: Identity): string {
  if (i.lookups === 0) return "  ⚠ Identity: lookup_customer NEVER ran (membership not checked)" + (i.triagedBeforeLookup ? "; triage_issue ran without it" : "");
  return (
    `  Identity: lookup_customer ran ${i.lookups}x; caller ${i.verified ? `verified (${i.member ? "active member" : "not a member"})` : "NOT verified"}` +
    (i.triagedBeforeLookup ? "; ⚠ triage_issue ran before the first lookup" : "")
  );
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);

/** Nearest-rank percentile (p in 0..100) of the finite values; null when empty. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(rank, xs.length) - 1];
}

export function stats(values: number[]): Stats {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null };
}

/** End of a message in epoch ms: endTime, else time + duration (seconds or ms, Vapi has used both). */
function endOf(m: JsonObject): number | null {
  const end = num(m.endTime);
  if (end !== null) return end;
  const t = num(m.time);
  const d = num(m.duration);
  if (t === null || d === null) return null;
  return t + (d < 1000 ? d * 1000 : d);
}

/** Group the transcript into caller → assistant turns, with any tool calls in between. */
export function buildTurns(messages: JsonObject[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    // Consecutive caller fragments count as one turn; the last one's end is when they stopped.
    let last = m;
    let text = str(m.message) ?? "";
    let j = i + 1;
    while (j < messages.length && messages[j].role === "user") {
      last = messages[j];
      text += ` ${str(messages[j].message) ?? ""}`;
      j++;
    }
    const pending = new Map<string, { name: string; at: number | null }>();
    const tools: ToolTiming[] = [];
    let reply: JsonObject | null = null;
    for (; j < messages.length; j++) {
      const n = messages[j];
      if (n.role === "user") break;
      if (n.role === "tool_calls" && Array.isArray(n.toolCalls)) {
        for (const tc of n.toolCalls as JsonObject[]) {
          const fn = obj(tc.function);
          pending.set(String(tc.id), { name: str(fn?.name) ?? "?", at: num(n.time) });
        }
      } else if (n.role === "tool_call_result") {
        const p = pending.get(String(n.toolCallId));
        const at = num(n.time);
        tools.push({ name: p?.name ?? str(n.name) ?? "?", ms: p?.at != null && at !== null ? Math.round(at - p.at) : null });
        pending.delete(String(n.toolCallId));
      } else if (n.role === "bot" || n.role === "assistant") {
        reply = n;
        break;
      }
    }
    // Tool results often arrive after the filler line ("One sec…") that counts as the reply.
    for (let k = j + 1; k < messages.length && pending.size && messages[k].role !== "user"; k++) {
      const n = messages[k];
      if (n.role !== "tool_call_result") continue;
      const p = pending.get(String(n.toolCallId));
      if (!p) continue;
      const at = num(n.time);
      tools.push({ name: p.name, ms: p.at !== null && at !== null ? Math.round(at - p.at) : null });
      pending.delete(String(n.toolCallId));
    }
    for (const p of pending.values()) tools.push({ name: p.name, ms: null });
    const stop = endOf(last);
    const start = reply ? num(reply.time) : null;
    turns.push({
      index: turns.length + 1,
      callerText: text.trim(),
      assistantText: reply ? (str(reply.message) ?? "") : "",
      gapMs: stop !== null && start !== null ? Math.round(start - stop) : null,
      tools,
    });
    i = j - 1;
  }
  return turns;
}

/** How long the caller waited for each reply: gaps ≥ 0 (a negative gap is an overlap, not a wait). */
export function responseGaps(turns: Turn[]): number[] {
  return turns.map((t) => t.gapMs).filter((g): g is number => g !== null && g >= 0);
}

/** Per-call response time for the console: p50/p95 of the caller-stop → assistant-start waits. */
export function responseLatency(messages: unknown): { p50: number | null; p95: number | null; turns: number } {
  const gaps = responseGaps(buildTurns(Array.isArray(messages) ? (messages as JsonObject[]) : []));
  return { p50: percentile(gaps, 50), p95: percentile(gaps, 95), turns: gaps.length };
}

export function buildCallReport(call: JsonObject): CallReport {
  const artifact = obj(call.artifact) ?? {};
  const messages = ((Array.isArray(artifact.messages) ? artifact.messages : call.messages) ?? []) as JsonObject[];
  const turns = buildTurns(messages);
  const perf = obj(artifact.performanceMetrics);
  const vapiLatencies = (Array.isArray(perf?.turnLatencies) ? (perf!.turnLatencies as JsonObject[]) : []).map((t) => ({
    modelMs: num(t.modelLatency),
    voiceMs: num(t.voiceLatency),
    transcriberMs: num(t.transcriberLatency),
    endpointingMs: num(t.endpointingLatency),
    turnMs: num(t.turnLatency),
  }));
  const averages = Object.fromEntries(
    ["endpointingLatencyAverage", "transcriberLatencyAverage", "modelLatencyAverage", "voiceLatencyAverage", "turnLatencyAverage", "fromTransportLatencyAverage", "toTransportLatencyAverage"].map(
      (k) => [k, num(perf?.[k])],
    ),
  );
  const bots = messages.filter((m) => m.role === "bot" || m.role === "assistant");
  const recording = obj(artifact.recording);
  const mono = obj(recording?.mono);
  const started = str(call.startedAt);
  const ended = str(call.endedAt);
  const gaps = (pred: (t: Turn) => boolean) => responseGaps(turns.filter(pred));
  return {
    id: String(call.id ?? "?"),
    startedAt: started,
    endedReason: str(call.endedReason),
    durationSec: started && ended ? Math.round((Date.parse(ended) - Date.parse(started)) / 1000) : null,
    turns,
    vapiLatencies,
    vapiAverages: averages,
    interruptions: { avaCutIn: num(perf?.numUserInterrupted), callerBargedIn: num(perf?.numAssistantInterrupted) },
    identity: identityOf(messages),
    log: null,
    teardown: null,
    lastAssistantMessage: bots.length ? str(bots[bots.length - 1].message) : null,
    recordingUrl: str(artifact.recordingUrl) ?? str(mono?.combinedUrl) ?? str(call.recordingUrl),
    summary: {
      all: stats(gaps(() => true)),
      noTools: stats(gaps((t) => t.tools.length === 0)),
      withTools: stats(gaps((t) => t.tools.length > 0)),
      overlaps: turns.filter((t) => t.gapMs !== null && t.gapMs < 0).length,
    },
  };
}

const ms = (v: number | null) => (v === null ? "   -  " : `${String(Math.round(v)).padStart(5)}ms`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtStats = (s: Stats) => `n=${s.n} p50=${ms(s.p50).trim()} p95=${ms(s.p95).trim()} max=${ms(s.max).trim()}`;

/** Plain-text report for the terminal. */
export function formatCallReport(r: CallReport): string {
  const lines: string[] = [];
  lines.push(`Call ${r.id}  started ${r.startedAt ?? "?"}  ${r.durationSec ?? "?"} s  ended: ${r.endedReason ?? "?"}`);
  lines.push(formatIdentity(r.identity));
  lines.push("");
  lines.push("  #   gap      tools                                  caller → Ava");
  for (const t of r.turns) {
    const tools = t.tools.map((x) => `${x.name} ${x.ms === null ? "?" : `${x.ms}ms`}`).join(", ");
    lines.push(`  ${String(t.index).padStart(2)} ${ms(t.gapMs)}  ${clip(tools, 38).padEnd(38)} ${clip(t.callerText, 40)} → ${clip(t.assistantText, 50)}`);
  }
  lines.push("");
  lines.push(`  Caller stop → Ava start: all ${fmtStats(r.summary.all)} | no tools ${fmtStats(r.summary.noTools)} | with tools ${fmtStats(r.summary.withTools)} | overlaps ${r.summary.overlaps}`);
  if (r.vapiLatencies.length) {
    lines.push("");
    lines.push("  Vapi turn latencies       endpoint  transcr.    model    voice     turn");
    r.vapiLatencies.forEach((t, i) =>
      lines.push(`  ${String(i + 1).padStart(2)}                     ${ms(t.endpointingMs)} ${ms(t.transcriberMs)} ${ms(t.modelMs)} ${ms(t.voiceMs)} ${ms(t.turnMs)}`),
    );
    const col = (k: keyof TurnLatencyRow) => r.vapiLatencies.map((t) => t[k]).filter((v): v is number => v !== null);
    for (const [label, k] of [["endpointing", "endpointingMs"], ["transcriber", "transcriberMs"], ["model", "modelMs"], ["voice", "voiceMs"], ["turn", "turnMs"]] as const) {
      lines.push(`  ${label.padEnd(12)} ${fmtStats(stats(col(k)))}`);
    }
  } else {
    lines.push("  (no artifact.performanceMetrics.turnLatencies on this call)");
  }
  const avg = Object.entries(r.vapiAverages).filter(([, v]) => v !== null);
  if (avg.length) lines.push(`  Vapi averages: ${avg.map(([k, v]) => `${k.replace("LatencyAverage", "")}=${Math.round(v!)}ms`).join("  ")}`);
  lines.push(`  Interruptions: Ava cut in on the caller ${r.interruptions.avaCutIn ?? "?"}x; caller barged in on Ava ${r.interruptions.callerBargedIn ?? "?"}x`);
  if (r.log) lines.push(...formatLogAnalysis(r.log));
  if (r.teardown) lines.push(formatTeardown(r.teardown));
  lines.push(`  Last Ava message: ${r.lastAssistantMessage ? JSON.stringify(r.lastAssistantMessage) : "-"}`);
  lines.push(`  Recording: ${r.recordingUrl ?? "-"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Vapi's per-call log (gzip NDJSON at artifact.presignedLogUrl). Each row: { time (epoch ms), body,
// attributes: { category, event, ... } }. Read for what the message list can't show: how long each
// webhook took as Vapi saw it, and when the line was really torn down after the goodbye.

export type LogRow = { time: number; body?: string; attributes?: JsonObject };

export type WebhookTiming = { messageType: string; at: number; latencyMs: number | null; statusCode: number | null; url: string | null };

export type ToolSpan = {
  names: string[];
  /** assistant.tool.started → assistant.tool.completed (Vapi waits for the filler to finish speaking). */
  totalMs: number | null;
  /** The tool-calls webhook round trip as Vapi measured it (Vapi → our server → Vapi). */
  webhookMs: number | null;
  /** The filler's speech: started / stopped, ms after the tool started. */
  fillerStartMs: number | null;
  fillerStopMs: number | null;
};

export type EndingTiming = {
  /** endCall started → goodbye audio started. */
  goodbyeStartMs: number | null;
  goodbyeDurationMs: number | null;
  /** Goodbye stopped (epoch ms): the anchor for everything below. */
  goodbyeStopAt: number | null;
  /** Goodbye stopped → our answer to phone-call-control reached Vapi (or its final failure). */
  hangupAckAfterGoodbyeMs: number | null;
  /** HTTP status of that answer (the Oct 21 regression answered 502 after 8.6 s). */
  hangupAckStatus: number | null;
  /** Goodbye stopped → Vapi's stream cleanup. Not the line drop: it lags Vapi's end of call by ~2.6 s. */
  silentTailMs: number | null;
  /** An idle hook ("Are you still there?") fired after the goodbye: the line was still open. */
  hookAfterGoodbye: boolean;
};

export type LogAnalysis = { webhooks: WebhookTiming[]; tools: ToolSpan[]; ending: EndingTiming | null };

const ev = (r: LogRow) => String(r.attributes?.event ?? "");

export function analyzeLog(rowsIn: LogRow[]): LogAnalysis {
  const rows = [...rowsIn].filter((r) => typeof r.time === "number").sort((a, b) => a.time - b.time);
  const webhooks: WebhookTiming[] = rows
    .filter((r) => ev(r) === "serverMessage.requestSucceeded" || ev(r) === "serverMessage.requestFailed")
    .map((r) => ({
      messageType: String(r.attributes?.messageType ?? "?"),
      at: r.time,
      latencyMs: num(r.attributes?.latencyMs),
      statusCode: num(r.attributes?.statusCode),
      url: str(r.attributes?.url),
    }));

  const tools: ToolSpan[] = [];
  let ending: EndingTiming | null = null;
  rows.forEach((r, i) => {
    if (ev(r) !== "assistant.tool.started") return;
    const names = Array.isArray(r.attributes?.toolNames) ? (r.attributes!.toolNames as string[]) : [];
    const after = rows.slice(i + 1);
    const completed = after.find((x) => ev(x) === "assistant.tool.completed");
    const until = completed?.time ?? Infinity;
    const speechStart = after.find((x) => ev(x) === "pipeline.botSpeechStarted" && x.time <= until);
    const speechStop = after.find((x) => ev(x) === "pipeline.botSpeechStopped" && x.time <= until + 5);
    const hook = after.find((x) => ev(x).startsWith("serverMessage.request") && x.attributes?.messageType === "tool-calls" && x.time <= until + 5);
    tools.push({
      names,
      totalMs: completed ? completed.time - r.time : null,
      webhookMs: num(hook?.attributes?.latencyMs),
      fillerStartMs: speechStart ? speechStart.time - r.time : null,
      fillerStopMs: speechStop ? speechStop.time - r.time : null,
    });
    if (names.includes("endCall")) {
      const control = after.find((x) => ev(x).startsWith("serverMessage.request") && x.attributes?.messageType === "phone-call-control");
      const cleanup = after.find((x) => /\.cleanup$/.test(ev(x)));
      const stop = speechStop?.time ?? null;
      ending = {
        goodbyeStartMs: speechStart ? speechStart.time - r.time : null,
        goodbyeDurationMs: speechStart && speechStop ? speechStop.time - speechStart.time : null,
        goodbyeStopAt: stop,
        hangupAckAfterGoodbyeMs: control && stop !== null ? control.time - stop : null,
        hangupAckStatus: num(control?.attributes?.statusCode),
        silentTailMs: cleanup && stop !== null ? cleanup.time - stop : null,
        hookAfterGoodbye: stop !== null && after.some((x) => ev(x) === "call.hookTriggered" && x.time > stop),
      };
    }
  });
  return { webhooks, tools, ending };
}

function formatLogAnalysis(a: LogAnalysis): string[] {
  const lines = ["", "  From Vapi's call log:"];
  for (const t of a.tools.filter((x) => !x.names.includes("endCall"))) {
    lines.push(
      `    ${t.names.join(",").padEnd(24)} webhook (Vapi → our server → Vapi) ${ms(t.webhookMs).trim().padStart(7)} | filler ${ms(t.fillerStartMs).trim()}–${ms(t.fillerStopMs).trim()} | tool done ${ms(t.totalMs).trim()}`,
    );
  }
  const hooks = a.webhooks.filter((w) => w.messageType === "tool-calls").map((w) => w.latencyMs).filter((v): v is number => v !== null);
  if (hooks.length) lines.push(`    tool-calls webhooks: ${fmtStats(stats(hooks))}`);
  const e = a.ending;
  if (e) {
    lines.push(
      `    Ending: goodbye starts ${ms(e.goodbyeStartMs).trim()} after endCall, lasts ${ms(e.goodbyeDurationMs).trim()}; our hang-up answer reached Vapi ${ms(e.hangupAckAfterGoodbyeMs).trim()} after it (HTTP ${e.hangupAckStatus ?? "?"}); Vapi stream cleanup at +${ms(e.silentTailMs).trim()}`,
    );
    if (e.hookAfterGoodbye) lines.push("    ⚠ An idle hook fired after the goodbye: the line was still open.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The real line drop: the SIP BYE in Vapi's packet capture (artifact.presignedPcapUrl, classic
// pcap of the SIP signalling). Measured Oct 21: Vapi's own hang-up sends BYE ~0.1 s after the
// goodbye stops; the morning delegated version 3.57 s; Vapi's "cleanup" log row is not the drop.

/** Anything later than this after the goodbye stops is flagged (the caller hears dead air). */
export const TEARDOWN_LIMIT_MS = 2500;

/** Epoch ms of every SIP BYE request in a classic pcap (µs or ns timestamps, either byte order). */
export function sipByeTimes(pcap: Uint8Array): number[] {
  if (pcap.length < 24) return [];
  const view = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
  const magicLE = view.getUint32(0, true);
  const formats: Record<number, { le: boolean; nano: boolean }> = {
    0xa1b2c3d4: { le: true, nano: false },
    0xa1b23c4d: { le: true, nano: true },
    0xd4c3b2a1: { le: false, nano: false },
    0x4d3cb2a1: { le: false, nano: true },
  };
  const fmt = formats[magicLE];
  if (!fmt) return [];
  const out: number[] = [];
  const decoder = new TextDecoder("latin1");
  for (let p = 24; p + 16 <= pcap.length; ) {
    const sec = view.getUint32(p, fmt.le);
    const frac = view.getUint32(p + 4, fmt.le);
    const incl = view.getUint32(p + 8, fmt.le);
    const data = pcap.subarray(p + 16, Math.min(pcap.length, p + 16 + incl));
    if (/(^|\r?\n|[^A-Z])BYE sip:/.test(decoder.decode(data))) out.push(sec * 1000 + (fmt.nano ? frac / 1e6 : frac / 1000));
    p += 16 + incl;
  }
  return out;
}

export type Teardown = { byeAfterGoodbyeMs: number | null; flagged: boolean; note: string };

/** Goodbye stop → first SIP BYE after it, flagged when over TEARDOWN_LIMIT_MS (or missing). */
export function teardownTiming(goodbyeStopAt: number | null, byeTimes: number[]): Teardown {
  if (goodbyeStopAt === null) return { byeAfterGoodbyeMs: null, flagged: false, note: "no endCall goodbye in the log" };
  const bye = byeTimes.filter((t) => t >= goodbyeStopAt - 1000).sort((a, b) => a - b)[0];
  if (bye === undefined) return { byeAfterGoodbyeMs: null, flagged: true, note: "no SIP BYE in the capture (the line wasn't hung up by the end of the capture)" };
  const after = Math.round(bye - goodbyeStopAt);
  return {
    byeAfterGoodbyeMs: after,
    flagged: after > TEARDOWN_LIMIT_MS,
    note: after > TEARDOWN_LIMIT_MS ? `over the ${TEARDOWN_LIMIT_MS} ms limit` : after < 500 ? "very early: the carrier may clip the last words" : "ok",
  };
}

export function formatTeardown(t: Teardown): string {
  const flag = t.flagged ? "⚠ " : "";
  return `  ${flag}Teardown (SIP BYE after the goodbye stopped): ${t.byeAfterGoodbyeMs === null ? "-" : `${t.byeAfterGoodbyeMs}ms`} (${t.note})`;
}
