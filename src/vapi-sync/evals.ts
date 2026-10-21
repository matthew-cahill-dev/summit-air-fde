// Scenario evals on Vapi Simulations (https://docs.vapi.ai/observability/simulations-overview).
// Pure helpers: scenario files → Vapi CreateScenarioDTO, cost estimate, run summary.
// The network side is scripts/run-evals.ts. Endpoints and field names were checked
// against https://api.vapi.ai/api-json on Oct 20, 2026.
// Keep this file free of path aliases: it is compiled for scripts/run-evals.ts.
import { stripComments, type JsonObject } from "./render";

/** Every scenario Vapi stores for us is named with this prefix, so upserts match by name. */
export const SCENARIO_PREFIX = "summit-air: ";

export type ScenarioCheck = {
  /** Structured output name: snake_case, at most 40 characters. */
  name: string;
  /** The judge's yes/no question about the conversation. */
  question: string;
  expect: boolean;
};

export type ScenarioFile = {
  /** Short id, e.g. "e-gas-smell" (the file name without .json). */
  id: string;
  title: string;
  /** Which reviewer requirement it demonstrates: a–f, "unexpected" or "quality". */
  requirement: string;
  /** What the simulated caller knows and wants, written to the tester. */
  instructions: string;
  checks: ScenarioCheck[];
};

const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Validate one parsed vapi/simulations/*.json file. Throws with every problem listed. */
export function parseScenarioFile(id: string, raw: unknown): ScenarioFile {
  const v = stripComments(raw) as JsonObject;
  const problems: string[] = [];
  const str = (k: string) => (typeof v[k] === "string" && (v[k] as string).trim() ? (v[k] as string).trim() : null);
  const title = str("title");
  const requirement = str("requirement");
  const instructions = str("instructions");
  if (!title) problems.push("title is required");
  if (!requirement) problems.push("requirement is required");
  if (!instructions) problems.push("instructions is required");
  if (instructions && instructions.length > 10_000) problems.push("instructions is over 10000 characters");
  if (title && (SCENARIO_PREFIX + title).length > 80) problems.push(`title is too long (Vapi allows 80 with the "${SCENARIO_PREFIX}" prefix)`);
  const checks = Array.isArray(v.checks) ? (v.checks as JsonObject[]) : [];
  if (checks.length === 0) problems.push("at least one check is required");
  const seen = new Set<string>();
  checks.forEach((c, i) => {
    if (typeof c.name !== "string" || !NAME_RE.test(c.name)) problems.push(`checks[${i}].name must be snake_case, at most 40 characters`);
    else if (seen.has(c.name)) problems.push(`checks[${i}].name "${c.name}" is repeated`);
    else seen.add(c.name);
    if (typeof c.question !== "string" || c.question.trim().length < 10) problems.push(`checks[${i}].question is required`);
    if (typeof c.expect !== "boolean") problems.push(`checks[${i}].expect must be true or false`);
  });
  if (problems.length) throw new Error(`vapi/simulations/${id}.json: ${problems.join("; ")}`);
  return {
    id,
    title: title!,
    requirement: requirement!,
    instructions: instructions!,
    checks: checks.map((c) => ({ name: c.name as string, question: (c.question as string).trim(), expect: c.expect as boolean })),
  };
}

export const scenarioName = (s: ScenarioFile) => SCENARIO_PREFIX + s.title;

/** The tester is told how the conversation ends, so a run doesn't idle until the time limit. */
const CLOSING =
  "\n\nYou are the CALLER, not the assistant. Speak naturally and briefly, one or two sentences per turn, and only answer what you're asked. " +
  "Don't volunteer details before you're asked unless the scenario says to. When your goal is met or the assistant says goodbye, say thanks and end the conversation.";

/** CreateScenarioDTO: each check is an inline boolean AI structured output that must equal `expect`. */
export function buildScenarioDto(s: ScenarioFile): JsonObject {
  return {
    name: scenarioName(s),
    instructions: s.instructions + CLOSING,
    evaluations: s.checks.map((c) => ({
      structuredOutput: {
        name: c.name,
        type: "ai",
        description: `Read the whole conversation between the Summit Air assistant and the caller. ${c.question} Answer true or false.`,
        schema: { type: "boolean" },
      },
      comparator: "=",
      value: c.expect,
      required: true,
    })),
  };
}

export type Transport = "vapi.webchat" | "vapi.websocket";

/**
 * Vapi doesn't publish simulation pricing (checked Oct 2026). Assumption: a chat run bills the
 * target's and tester's LLM tokens plus the judge (~$0.10 a scenario with gpt-4.1); a voice run
 * bills two call legs of about 4 minutes at Vapi's ~$0.10–0.15 per minute all-in (~$1).
 */
export const ESTIMATED_USD_PER_SCENARIO: Record<Transport, number> = { "vapi.webchat": 0.1, "vapi.websocket": 1.0 };

export function estimateCostUsd(scenarios: number, transport: Transport, iterations = 1): number {
  return Math.round(scenarios * iterations * ESTIMATED_USD_PER_SCENARIO[transport] * 100) / 100;
}

export type RunItem = {
  scenarioId?: string;
  status: string;
  failureReason?: string;
  results?: { passed?: boolean; evaluations?: Array<{ name?: string; passed?: boolean; extractedValue?: unknown; expectedValue?: unknown; error?: string }> };
};

export type ScenarioOutcome = {
  title: string;
  passed: boolean | null;
  status: string;
  failedChecks: string[];
  note: string | null;
};

/**
 * One line per scenario, in file order. With several iterations a scenario passes only if every
 * iteration passed. `null` passed = an item never finished (canceled, still running, missing).
 */
export function summarizeRun(scenarios: Array<{ file: ScenarioFile; scenarioId: string }>, items: RunItem[]): ScenarioOutcome[] {
  return scenarios.map(({ file, scenarioId }) => {
    const mine = items.filter((i) => i.scenarioId === scenarioId);
    if (mine.length === 0) return { title: file.title, passed: null, status: "missing", failedChecks: [], note: "No run item for this scenario" };
    const finished = mine.every((i) => i.status === "passed" || i.status === "failed");
    const failedChecks = mine.flatMap((i) =>
      (i.results?.evaluations ?? [])
        .filter((e) => e.passed === false)
        .map((e) => `${e.name ?? "?"} (got ${JSON.stringify(e.extractedValue)}, wanted ${JSON.stringify(e.expectedValue)})${e.error ? `: ${e.error}` : ""}`),
    );
    const statuses = [...new Set(mine.map((i) => i.status))];
    const notes = [...new Set(mine.map((i) => i.failureReason).filter((r): r is string => Boolean(r)))];
    return {
      title: file.title,
      passed: finished ? mine.every((i) => i.status === "passed") : null,
      status: mine.length > 1 ? `${mine.filter((i) => i.status === "passed").length}/${mine.length} passed` : statuses[0],
      failedChecks: [...new Set(failedChecks)],
      note: notes.length ? notes.join("; ") : null,
    };
  });
}
