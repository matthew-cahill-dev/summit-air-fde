import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScenarioDto,
  estimateCostUsd,
  parseScenarioFile,
  SCENARIO_PREFIX,
  summarizeRun,
  type ScenarioFile,
} from "@/vapi-sync/evals";

const DIR = join(process.cwd(), "vapi", "simulations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const scenarios = files.map((f) => parseScenarioFile(f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(DIR, f), "utf8"))));

describe("vapi/simulations/*.json", () => {
  it("has 10-12 valid scenarios covering every reviewer requirement and the edge cases", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(scenarios.length).toBeLessThanOrEqual(12);
    const covered = scenarios.flatMap((s) => s.requirement.split(/,\s*/));
    for (const r of ["a", "b", "c", "d", "e", "f", "unexpected", "quality"]) expect(covered, r).toContain(r);
    for (const id of ["e-gas-smell", "e-no-heat-elderly", "e-no-ac-medical", "b-commercial-caller", "c-member-lookup", "a-new-customer-tuneup", "f-reschedule", "unexpected-spanish-speaker", "unexpected-prompt-injection", "unexpected-correction-after-readback"]) {
      expect(scenarios.map((s) => s.id)).toContain(id);
    }
  });

  it("scenario names are unique (they're the upsert key) and fit Vapi's limits", () => {
    const names = scenarios.map((s) => s.title);
    expect(new Set(names).size).toBe(names.length);
    for (const s of scenarios) {
      const dto = buildScenarioDto(s);
      expect((dto.name as string).length).toBeLessThanOrEqual(80);
      expect((dto.instructions as string).length).toBeLessThanOrEqual(10_000);
    }
  });

  it("uses fictional 555 numbers only", () => {
    for (const s of scenarios) {
      for (const m of s.instructions.matchAll(/\b(\d{3})[ -.]?(\d{3})[ -.]?(\d{4})\b/g)) expect(m[2], s.id).toBe("555");
    }
  });
});

describe("buildScenarioDto", () => {
  const s: ScenarioFile = { id: "x", title: "Gas smell", requirement: "e", instructions: "You smell gas.", checks: [{ name: "leave_now", question: "Did it say leave now?", expect: true }] };

  it("maps each check to a required inline boolean structured output compared with =", () => {
    const dto = buildScenarioDto(s);
    expect(dto.name).toBe(`${SCENARIO_PREFIX}Gas smell`);
    expect(dto.instructions).toMatch(/^You smell gas\.\n\nYou are the CALLER/);
    expect(dto.evaluations).toEqual([
      {
        structuredOutput: { name: "leave_now", type: "ai", description: expect.stringContaining("Did it say leave now?"), schema: { type: "boolean" } },
        comparator: "=",
        value: true,
        required: true,
      },
    ]);
  });
});

describe("parseScenarioFile", () => {
  it("lists every problem at once", () => {
    expect(() => parseScenarioFile("bad", { title: "", checks: [{ name: "Bad Name", question: "?", expect: "yes" }] })).toThrow(
      /title is required.*requirement is required.*instructions is required.*snake_case.*question is required.*expect must be true or false/,
    );
  });

  it("strips _comments", () => {
    const s = parseScenarioFile("ok", { _comments: { a: 1 }, title: "T", requirement: "a", instructions: "Do it.", checks: [{ name: "ok", question: "Did it work out?", expect: true }] });
    expect(s).not.toHaveProperty("_comments");
  });
});

describe("cost estimate and run summary", () => {
  it("estimates chat at ~$0.10 and voice at ~$1 per scenario per iteration", () => {
    expect(estimateCostUsd(12, "vapi.webchat")).toBe(1.2);
    expect(estimateCostUsd(12, "vapi.websocket", 2)).toBe(24);
  });

  it("one line per scenario; every iteration must pass; unfinished items are neither", () => {
    const file = (title: string): ScenarioFile => ({ id: title, title, requirement: "a", instructions: "x", checks: [] });
    const out = summarizeRun(
      [
        { file: file("A"), scenarioId: "1" },
        { file: file("B"), scenarioId: "2" },
        { file: file("C"), scenarioId: "3" },
        { file: file("D"), scenarioId: "4" },
      ],
      [
        { scenarioId: "1", status: "passed", results: { passed: true, evaluations: [] } },
        { scenarioId: "2", status: "passed" },
        { scenarioId: "2", status: "failed", results: { evaluations: [{ name: "leave_now", passed: false, extractedValue: false, expectedValue: true }] } },
        { scenarioId: "3", status: "canceled", failureReason: "timeout" },
      ],
    );
    expect(out.map((o) => [o.title, o.passed, o.status])).toEqual([
      ["A", true, "passed"],
      ["B", false, "1/2 passed"],
      ["C", null, "canceled"],
      ["D", null, "missing"],
    ]);
    expect(out[1].failedChecks).toEqual(["leave_now (got false, wanted true)"]);
    expect(out[2].note).toBe("timeout");
  });
});
