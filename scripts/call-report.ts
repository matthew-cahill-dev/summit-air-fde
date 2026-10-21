// `npm run call-report -- <vapiCallId|latest> [--last N] [--json] [--no-log] [--any-assistant | --target s2s]`
//   latest: the most recent ended calls on VAPI_ASSISTANT_ID (or VAPI_S2S_ASSISTANT_ID with --target s2s;
//   any assistant with --any-assistant).
// Read-only: GET /call/{id} or GET /call?limit=N from the Vapi API, then per-turn latency
// (caller stop → Ava start), Vapi's own latency breakdown, tool durations, p50/p95,
// ended reason, last assistant message and recording URL. With the call log and SIP capture
// (skipped by --no-log): webhook times and the real hang-up (SIP BYE), flagged over 2.5 s
// (exit code 2). Never prints the API key.
import { gunzipSync } from "node:zlib";
import { analyzeLog, buildCallReport, formatCallReport, responseGaps, sipByeTimes, stats, teardownTiming, TEARDOWN_LIMIT_MS, type JsonObject, type LogRow } from "../src/vapi-sync/call-report";

async function main() {
  const args = process.argv.slice(2);
  // The positional argument: a call id or "latest". Values of --last and --target aren't positional.
  const target = args.find((a, i) => !a.startsWith("--") && !["--last", "--target"].includes(args[i - 1])) ?? "latest";
  const lastIdx = args.indexOf("--last");
  const last = lastIdx >= 0 ? Math.max(1, Math.min(50, Number(args[lastIdx + 1]) || 1)) : 1;
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env; use the process environment.
  }
  const apiKey = process.env.VAPI_API_KEY?.trim();
  if (!apiKey) throw new Error("VAPI_API_KEY is not set (add it to .env)");

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`https://api.vapi.ai${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vapi GET ${path} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };

  let calls: JsonObject[];
  if (target === "latest") {
    const qs = new URLSearchParams({ limit: String(last) });
    const s2s = args.includes("--target") && args[args.indexOf("--target") + 1] === "s2s";
    const assistantId = (s2s ? process.env.VAPI_S2S_ASSISTANT_ID : process.env.VAPI_ASSISTANT_ID)?.trim();
    if (s2s && !assistantId) throw new Error("VAPI_S2S_ASSISTANT_ID is not set (create the S2S assistant with npm run vapi:sync -- --target s2s)");
    if (assistantId && !args.includes("--any-assistant")) qs.set("assistantId", assistantId);
    const list = await get<JsonObject[] | { results: JsonObject[] }>(`/call?${qs}`);
    const rows = (Array.isArray(list) ? list : list.results).filter((c) => c.status === "ended" || c.endedAt);
    // The list may omit artifacts; fetch each call in full.
    calls = [];
    for (const c of rows.slice(0, last)) calls.push(await get<JsonObject>(`/call/${encodeURIComponent(String(c.id))}`));
  } else {
    calls = [await get<JsonObject>(`/call/${encodeURIComponent(target)}`)];
  }
  if (calls.length === 0) {
    console.log("No ended calls found.");
    return;
  }

  const reports = calls.map(buildCallReport);
  // Vapi's per-call log (presigned, gzip NDJSON): webhook latencies and the real hang-up time.
  if (!args.includes("--no-log")) {
    for (const [i, call] of calls.entries()) {
      const artifact = (call.artifact ?? {}) as JsonObject;
      const url = typeof artifact.presignedLogUrl === "string" ? artifact.presignedLogUrl : null;
      if (!url) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const raw = Buffer.from(await res.arrayBuffer());
        const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
        const rows = text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as LogRow);
        reports[i].log = analyzeLog(rows);
      } catch {
        // The log is optional; the report stands without it.
      }
      // The real line drop: the SIP BYE in Vapi's packet capture, timed from the goodbye's end.
      const pcapUrl = typeof artifact.presignedPcapUrl === "string" ? artifact.presignedPcapUrl : null;
      const stopAt = reports[i].log?.ending?.goodbyeStopAt ?? null;
      if (pcapUrl && stopAt !== null) {
        try {
          const res = await fetch(pcapUrl);
          if (res.ok) {
            const raw = Buffer.from(await res.arrayBuffer());
            const pcap = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
            reports[i].teardown = teardownTiming(stopAt, sipByeTimes(pcap));
          }
        } catch {
          // Optional too.
        }
      }
    }
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  console.log(reports.map(formatCallReport).join("\n\n" + "-".repeat(100) + "\n\n"));
  const late = reports.filter((r) => r.teardown?.flagged);
  if (late.length) {
    console.log(`\n⚠ ${late.length} call(s) with a teardown over ${TEARDOWN_LIMIT_MS} ms (or none at all): ${late.map((r) => r.id).join(", ")}`);
    process.exitCode = 2;
  }
  if (reports.length > 1) {
    const s = stats(reports.flatMap((r) => responseGaps(r.turns)));
    console.log(`\nAll ${reports.length} calls, caller stop → Ava start: n=${s.n} p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
