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
  interruptions: { user: number | null; assistant: number | null };
  lastAssistantMessage: string | null;
  recordingUrl: string | null;
  /** Response waits (non-negative gaps only); negative gaps are overlaps (someone barged in). */
  summary: { all: Stats; noTools: Stats; withTools: Stats; overlaps: number };
};

export type Stats = { n: number; p50: number | null; p95: number | null; max: number | null };

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
    interruptions: { user: num(perf?.numUserInterrupted), assistant: num(perf?.numAssistantInterrupted) },
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
  lines.push(`  Interruptions: caller interrupted Ava ${r.interruptions.user ?? "?"}x, Ava interrupted caller ${r.interruptions.assistant ?? "?"}x`);
  lines.push(`  Last Ava message: ${r.lastAssistantMessage ? JSON.stringify(r.lastAssistantMessage) : "-"}`);
  lines.push(`  Recording: ${r.recordingUrl ?? "-"}`);
  return lines.join("\n");
}
