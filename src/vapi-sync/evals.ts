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
  /** Subsets for `--only <tag>`: safety, privacy, business, conversation, voice, smoke, … plus req-a … req-f. */
  tags: string[];
  /** What the simulated caller knows and wants, written to the tester. */
  instructions: string;
  /** Tools the assistant must call, in this order (others may come in between). Becomes a check. */
  expectedTools: string[];
  /** Tools the assistant must never call on this call. One check each. */
  forbiddenTools: string[];
  /** Things the assistant must say (in its own words unless quoted exactly). One check each. */
  requiredPhrases: string[];
  checks: ScenarioCheck[];
};

/** Tool names the criteria may use (function tools plus Vapi's built-in endCall). */
export const KNOWN_TOOLS = [
  "lookup_customer",
  "triage_issue",
  "get_availability",
  "check_service_area",
  "book_appointment",
  "create_priority_dispatch",
  "create_callback_request",
  "transfer_to_on_call",
  "endCall",
] as const;

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
  const strList = (k: string) => {
    const raw = v[k];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x.trim())) {
      problems.push(`${k} must be a list of non-empty strings`);
      return [];
    }
    return (raw as string[]).map((x) => x.trim());
  };
  const tags = strList("tags");
  const expectedTools = strList("expectedTools");
  const forbiddenTools = strList("forbiddenTools");
  const requiredPhrases = strList("requiredPhrases");
  for (const t of [...expectedTools, ...forbiddenTools]) {
    if (!(KNOWN_TOOLS as readonly string[]).includes(t)) problems.push(`unknown tool "${t}"`);
  }
  for (const t of tags) if (!/^[a-z][a-z0-9-]*$/.test(t)) problems.push(`tag "${t}" must be lowercase kebab-case`);
  if (checks.length + expectedTools.length + forbiddenTools.length + requiredPhrases.length === 0) problems.push("at least one check is required");
  const seen = new Set<string>();
  checks.forEach((c, i) => {
    if (typeof c.name !== "string" || !NAME_RE.test(c.name)) problems.push(`checks[${i}].name must be snake_case, at most 40 characters`);
    else if (seen.has(c.name)) problems.push(`checks[${i}].name "${c.name}" is repeated`);
    else seen.add(c.name);
    if (typeof c.question !== "string" || c.question.trim().length < 10) problems.push(`checks[${i}].question is required`);
    if (typeof c.expect !== "boolean") problems.push(`checks[${i}].expect must be true or false`);
  });
  if (problems.length) throw new Error(`vapi/simulations/${id}.json: ${problems.join("; ")}`);
  const parsed: ScenarioFile = {
    id,
    title: title!,
    requirement: requirement!,
    tags: scenarioTags(id, requirement!, tags),
    instructions: instructions!,
    expectedTools,
    forbiddenTools,
    requiredPhrases,
    checks: checks.map((c) => ({ name: c.name as string, question: (c.question as string).trim(), expect: c.expect as boolean })),
  };
  const all = allChecks(parsed).map((c) => c.name);
  const dup = all.find((n, i) => all.indexOf(n) !== i);
  if (dup) throw new Error(`vapi/simulations/${id}.json: check "${dup}" clashes with a generated check`);
  return parsed;
}

/** Explicit tags plus req-<letter> for each requirement letter. Sorted, unique. */
export function scenarioTags(id: string, requirement: string, explicit: string[]): string[] {
  const reqs = requirement
    .split(/,\s*/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)
    .map((r) => (/^[a-f]$/.test(r) ? `req-${r}` : r));
  return [...new Set([...explicit, ...reqs])].sort();
}

/**
 * The pass criteria as judge checks: the tool order, each forbidden tool, each required phrase,
 * then the hand-written checks. Every one must hold for the scenario to pass.
 */
export function allChecks(s: ScenarioFile): ScenarioCheck[] {
  const generated: ScenarioCheck[] = [];
  if (s.expectedTools.length) {
    generated.push({
      name: "tool_order",
      question:
        `Look at the assistant's tool calls. Did it call ${s.expectedTools.join(", then ")}, in that order? ` +
        "Other tool calls in between are fine, and a tool may be called more than once.",
      expect: true,
    });
  }
  for (const t of s.forbiddenTools) {
    generated.push({ name: `never_${t.toLowerCase()}`.slice(0, 40), question: `Did the assistant call the ${t} tool at any point?`, expect: false });
  }
  s.requiredPhrases.forEach((p, i) => {
    generated.push({
      name: `says_${i + 1}`,
      question: /^".*"$/.test(p) ? `Did the assistant say, word for word or nearly so, ${p}?` : `Did the assistant say this (in its own words): ${p}?`,
      expect: true,
    });
  });
  return [...generated, ...s.checks];
}

/** Pick scenarios by id or tag (`--only safety,e-gas-smell`). Unknown names are an error. */
export function selectScenarios(all: ScenarioFile[], only: string[] | null): ScenarioFile[] {
  if (!only || only.length === 0) return all;
  const unknown = only.filter((o) => !all.some((s) => s.id === o || s.tags.includes(o)));
  if (unknown.length) {
    const tags = [...new Set(all.flatMap((s) => s.tags))].sort();
    throw new Error(`Unknown scenario id or tag: ${unknown.join(", ")}. Tags: ${tags.join(", ")}`);
  }
  return all.filter((s) => only.some((o) => s.id === o || s.tags.includes(o)));
}

/** One-line pass criteria for the docs table and the run listing. */
export function passCriteria(s: ScenarioFile): string {
  const parts = [
    s.expectedTools.length ? `tools: ${s.expectedTools.join(" → ")}` : null,
    s.forbiddenTools.length ? `never: ${s.forbiddenTools.join(", ")}` : null,
    s.requiredPhrases.length ? `says: ${s.requiredPhrases.length}` : null,
    `checks: ${s.checks.length}`,
  ].filter(Boolean);
  return parts.join("; ");
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
    evaluations: allChecks(s).map((c) => ({
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

/**
 * The simulated caller for every scenario. Neutral on purpose: who the caller is, what they want
 * and any adversarial behavior (injection, abuse, refusing to leave…) live in each scenario's
 * instructions, so one personality serves the whole suite. Same shape as Vapi's built-in
 * personalities (GET /eval/simulation/personality): an assistant with a system prompt and endCall.
 * None of the built-ins fit: "Decisive Derek" is an idealized caller, the rest are styles
 * (rambling, impatient, confused…) that would distort every scenario.
 */
export const PERSONALITY_NAME = "summit-air: NYC caller";

export const PERSONALITY_PROMPT = [
  "You are an ordinary New York City resident phoning a heating and cooling company.",
  "You're cooperative and polite but realistic: you talk like a normal person on the phone, in short natural answers (one or two sentences), with the occasional 'um' or 'yeah'.",
  "You answer what you're asked and don't volunteer details before they're asked for, unless your scenario says to.",
  "Your scenario instructions decide who you are, your details, what you want and how you behave. Follow them exactly. When they tell you to be difficult, confused, upset or to test the assistant, do that; otherwise stay cooperative.",
  "Never contradict your scenario. If you're asked something it doesn't cover, give a short plausible answer or say you're not sure.",
  "Say phone numbers, house numbers and ZIP codes the way people do on the phone.",
  "When your goal is met or the assistant says goodbye, thank them briefly and end the call.",
].join(" ");

/** CreatePersonalityDTO / UpdatePersonalityDTO body. */
export function buildPersonalityDto(): JsonObject {
  return {
    name: PERSONALITY_NAME,
    assistant: {
      model: {
        provider: "openai",
        model: "gpt-4.1",
        messages: [{ role: "system", content: PERSONALITY_PROMPT }],
        tools: [{ type: "endCall" }],
      },
    },
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
