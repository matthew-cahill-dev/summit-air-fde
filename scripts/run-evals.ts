// `npm run evals -- [--confirm] [--voice] [--only <id|tag,...>] [--personality <id>] [--iterations <n>]`
//   (default)    validate vapi/simulations/*.json, print the scenarios and an estimated cost; no network
//   --confirm    upsert the scenarios in Vapi, run them against VAPI_ASSISTANT_ID, print pass/fail
//   --voice      voice transport (vapi.websocket) instead of chat (vapi.webchat); ~10x the cost
//   --only       a subset by file id or tag, e.g. --only safety or --only privacy,e-gas-smell
//                (tags: safety, privacy, business, conversation, voice, smoke, req-a … req-f, unexpected, quality)
//
// Runs hit the LIVE assistant and its tools, so bookings, callbacks and dispatches land in the
// production database. Clean up afterwards with `npm run db:reset-test -- --confirm`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allChecks,
  buildScenarioDto,
  estimateCostUsd,
  parseScenarioFile,
  passCriteria,
  scenarioName,
  selectScenarios,
  summarizeRun,
  type RunItem,
  type ScenarioFile,
  type Transport,
} from "../src/vapi-sync/evals";
import type { JsonObject } from "../src/vapi-sync/render";

const SIM_DIR = join(process.cwd(), "vapi", "simulations");
const POLL_MS = 10_000;
const MAX_WAIT_MS = 30 * 60_000;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadScenarios(only: string[] | null): ScenarioFile[] {
  const files = readdirSync(SIM_DIR).filter((f) => f.endsWith(".json")).sort();
  const all = files.map((f) => parseScenarioFile(f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(SIM_DIR, f), "utf8"))));
  return selectScenarios(all, only);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const transport: Transport = args.includes("--voice") ? "vapi.websocket" : "vapi.webchat";
  const iterations = Math.min(10, Math.max(1, Number(flag(args, "--iterations") ?? 1)));
  const only = flag(args, "--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env; use the process environment.
  }

  const scenarios = loadScenarios(only);
  // The estimate comes first, before anything is listed or sent.
  const cost = estimateCostUsd(scenarios.length, transport, iterations);
  console.log(`Estimated Vapi cost: about $${cost.toFixed(2)} for ${scenarios.length} scenario(s) × ${iterations} iteration(s) on ${transport} (an estimate: Vapi doesn't publish simulation pricing).\n`);
  for (const s of scenarios) {
    console.log(`  [${s.tags.join(" ")}] ${s.id}: ${s.title} (${allChecks(s).length} checks; ${passCriteria(s)})`);
  }
  const voiceOnly = scenarios.filter((s) => s.tags.includes("voice"));
  if (voiceOnly.length && transport !== "vapi.websocket") {
    console.log(`\nNote: ${voiceOnly.map((s) => s.id).join(", ")} test timing or audio (interruptions, silence, a mumbled word); they mean most with --voice.`);
  }
  if (!confirm) {
    console.log("Nothing was sent. Re-run with --confirm to create/update the scenarios and run them against the live assistant.");
    return;
  }

  const apiKey = process.env.VAPI_API_KEY?.trim();
  const assistantId = process.env.VAPI_ASSISTANT_ID?.trim();
  if (!apiKey || !assistantId) throw new Error("VAPI_API_KEY and VAPI_ASSISTANT_ID must be set (add them to .env)");
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`https://api.vapi.ai${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vapi ${method} ${path} failed with HTTP ${res.status}: ${text.slice(0, 600)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const list = <T>(body: T[] | { results: T[] }) => (Array.isArray(body) ? body : body.results);

  // 1. Upsert scenarios by name.
  const existing = list(await request<JsonObject[] | { results: JsonObject[] }>("GET", "/eval/simulation/scenario?limit=1000"));
  const upserted: Array<{ file: ScenarioFile; scenarioId: string }> = [];
  for (const file of scenarios) {
    const dto = buildScenarioDto(file);
    const match = existing.find((e) => e.name === scenarioName(file));
    const saved = match
      ? await request<JsonObject>("PATCH", `/eval/simulation/scenario/${match.id}`, dto)
      : await request<JsonObject>("POST", "/eval/simulation/scenario", dto);
    upserted.push({ file, scenarioId: String(saved.id) });
    console.log(`${match ? "updated" : "created"} scenario ${file.id} (${saved.id})`);
  }

  // 2. Personality: --personality, else a Vapi built-in (orgId null), preferring one marked default.
  let personalityId = flag(args, "--personality");
  if (!personalityId) {
    const builtIn = list(await request<JsonObject[] | { results: JsonObject[] }>("GET", "/eval/simulation/personality?limit=100")).filter(
      (p) => p.orgId === null,
    );
    const pick = builtIn.find((p) => /default/i.test(String(p.name))) ?? builtIn[0];
    if (!pick) throw new Error("No built-in personality found; pass --personality <id>");
    personalityId = String(pick.id);
    console.log(`personality: ${pick.name} (${pick.id})`);
  }

  // 3. Run.
  const run = await request<JsonObject>("POST", "/eval/simulation/run", {
    simulations: upserted.map((u) => ({ type: "simulation", scenarioId: u.scenarioId, personalityId })),
    target: { type: "assistant", assistantId },
    transport: { provider: transport },
    iterations,
  });
  console.log(`\nrun ${run.id} queued${run.url ? `: ${run.url}` : ""}`);

  // 4. Poll until ended.
  const started = Date.now();
  let status = String(run.status);
  while (status !== "ended") {
    if (Date.now() - started > MAX_WAIT_MS) throw new Error(`Run ${run.id} still ${status} after 30 minutes; check the Vapi dashboard`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    const current = await request<JsonObject>("GET", `/eval/simulation/run/${run.id}`);
    status = String(current.status);
    const c = (current.itemCounts ?? {}) as Record<string, number>;
    console.log(`  ${status}: ${c.passed ?? 0} passed, ${c.failed ?? 0} failed, ${c.running ?? 0} running, ${c.queued ?? 0} queued`);
  }

  // 5. Results, one line per scenario.
  const items = list(await request<RunItem[] | { results: RunItem[] }>("GET", `/eval/simulation/run/${run.id}/item?limit=1000`));
  const outcomes = summarizeRun(upserted, items);
  console.log("");
  for (const o of outcomes) {
    console.log(`${o.passed === true ? "PASS" : o.passed === false ? "FAIL" : "----"}  ${o.title}  [${o.status}]`);
    for (const f of o.failedChecks) console.log(`        ✗ ${f}`);
    if (o.note) console.log(`        ${o.note}`);
  }
  const passed = outcomes.filter((o) => o.passed === true).length;
  console.log(`\n${passed}/${outcomes.length} passed. Test data from this run is in the database: npm run db:reset-test -- --confirm`);
  if (passed !== outcomes.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
