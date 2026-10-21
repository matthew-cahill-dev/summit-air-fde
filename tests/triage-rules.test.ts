import { describe, expect, it } from "vitest";
import { triageRules, type TriageFlags } from "@/server/triage/rules";
import type { CalendarDate } from "@/server/lib/time";

const IN_AREA = { zip: "11372", inArea: true, county: "Queens" };
const OUT_OF_AREA = { zip: "10025", inArea: false, county: null };

const d = (month: number, day: number): CalendarDate => ({ year: 2026, month, day });
const WINTER = d(1, 15); // heat season
const SUMMER = d(7, 15); // cooling season

const flags = (over: Partial<TriageFlags> = {}): TriageFlags => ({
  issueType: "maintenance",
  gasSmell: false,
  coAlarm: false,
  burningSmellOrSmoke: false,
  vulnerableOccupants: [],
  propertyType: "residential",
  ...over,
});

type Row = [name: string, f: Partial<TriageFlags>, today: CalendarDate, urgency: string, nextAction: string];

describe("triageRules", () => {
  const table: Row[] = [
    // safety_stop
    ["gas smell", { gasSmell: true }, WINTER, "safety_stop", "safety_instructions"],
    ["CO alarm", { coAlarm: true, issueType: "no_heat" }, SUMMER, "safety_stop", "safety_instructions"],
    ["burning smell/smoke", { burningSmellOrSmoke: true }, SUMMER, "safety_stop", "safety_instructions"],
    ["safety beats commercial", { gasSmell: true, propertyType: "commercial" }, WINTER, "safety_stop", "safety_instructions"],

    // no heat: emergency
    ["no heat, heat season, elderly", { issueType: "no_heat", vulnerableOccupants: ["elderly"] }, WINTER, "emergency", "priority_dispatch"],
    ["no heat, heat season, pregnant", { issueType: "no_heat", vulnerableOccupants: ["pregnant"] }, WINTER, "emergency", "priority_dispatch"],
    ["no heat 55°F (boundary) in summer", { issueType: "no_heat", indoorTempF: 55 }, SUMMER, "emergency", "priority_dispatch"],
    ["no heat 54°F in winter", { issueType: "no_heat", indoorTempF: 54 }, WINTER, "emergency", "priority_dispatch"],
    // no heat: urgent / routine
    ["no heat 56°F in winter", { issueType: "no_heat", indoorTempF: 56 }, WINTER, "urgent", "book_earliest"],
    ["no heat 56°F in summer", { issueType: "no_heat", indoorTempF: 56 }, SUMMER, "routine", "book_standard"],
    ["no heat, vulnerable, out of season, 60°F", { issueType: "no_heat", vulnerableOccupants: ["infant"], indoorTempF: 60 }, SUMMER, "urgent", "book_earliest"],
    ["no heat, elderly, out of season", { issueType: "no_heat", vulnerableOccupants: ["elderly"] }, SUMMER, "urgent", "book_earliest"],
    ["no heat, pregnant, out of season", { issueType: "no_heat", vulnerableOccupants: ["pregnant"] }, d(6, 1), "urgent", "book_earliest"],
    ["no heat, no vulnerable, out of season", { issueType: "no_heat" }, SUMMER, "routine", "book_standard"],

    // heat season edges
    ["no heat on Oct 1", { issueType: "no_heat" }, d(10, 1), "urgent", "book_earliest"],
    ["no heat on Sep 30", { issueType: "no_heat" }, d(9, 30), "routine", "book_standard"],
    ["no heat on May 31", { issueType: "no_heat" }, d(5, 31), "urgent", "book_earliest"],
    ["no heat on Jun 1", { issueType: "no_heat" }, d(6, 1), "routine", "book_standard"],
    ["no heat Jan 1 (season wraps year)", { issueType: "no_heat", vulnerableOccupants: ["disability"] }, d(1, 1), "emergency", "priority_dispatch"],

    // no cooling
    ["no cooling, summer, medical condition", { issueType: "no_cooling", vulnerableOccupants: ["medical_condition"] }, SUMMER, "emergency", "priority_dispatch"],
    ["no cooling, winter, medical equipment, 85°F (boundary)", { issueType: "no_cooling", vulnerableOccupants: ["medical_equipment"], indoorTempF: 85 }, WINTER, "emergency", "priority_dispatch"],
    ["no cooling, winter, elderly, 84°F", { issueType: "no_cooling", vulnerableOccupants: ["elderly"], indoorTempF: 84 }, WINTER, "urgent", "book_earliest"],
    ["no cooling, winter, medical condition, no temp", { issueType: "no_cooling", vulnerableOccupants: ["medical_condition"] }, WINTER, "urgent", "book_earliest"],
    ["no cooling, Oct 1, elderly", { issueType: "no_cooling", vulnerableOccupants: ["elderly"] }, d(10, 1), "urgent", "book_earliest"],
    ["no cooling, winter, disability (not medical), 90°F", { issueType: "no_cooling", vulnerableOccupants: ["disability"], indoorTempF: 90 }, WINTER, "urgent", "book_earliest"],
    ["no cooling, winter, no vulnerable, 90°F", { issueType: "no_cooling", indoorTempF: 90 }, WINTER, "routine", "book_standard"],
    ["no cooling, summer, pregnant only (not medical)", { issueType: "no_cooling", vulnerableOccupants: ["pregnant"] }, SUMMER, "urgent", "book_earliest"],
    ["no cooling, summer, 85°F, no vulnerable", { issueType: "no_cooling", indoorTempF: 85 }, SUMMER, "urgent", "book_earliest"],
    ["no cooling on Jun 1", { issueType: "no_cooling" }, d(6, 1), "urgent", "book_earliest"],
    ["no cooling on Sep 30", { issueType: "no_cooling" }, d(9, 30), "urgent", "book_earliest"],
    ["no cooling on Oct 1", { issueType: "no_cooling" }, d(10, 1), "routine", "book_standard"],
    ["no cooling on May 31", { issueType: "no_cooling" }, d(5, 31), "routine", "book_standard"],
    ["no cooling, infant, May 31, 85°F", { issueType: "no_cooling", vulnerableOccupants: ["infant"], indoorTempF: 85 }, d(5, 31), "emergency", "priority_dispatch"],

    // leak and routine
    ["active leak", { issueType: "leak" }, SUMMER, "urgent", "book_earliest"],
    ["maintenance", { issueType: "maintenance" }, WINTER, "routine", "book_standard"],
    ["noise", { issueType: "noise" }, WINTER, "routine", "book_standard"],
    ["thermostat", { issueType: "thermostat" }, WINTER, "routine", "book_standard"],
    ["other", { issueType: "other" }, WINTER, "routine", "book_standard"],

    // serviceability
    ["commercial", { propertyType: "commercial", issueType: "no_heat" }, WINTER, "urgent", "explain_and_close"],
  ];

  it.each(table)("%s", (_name, f, today, urgency, nextAction) => {
    const out = triageRules(flags(f), IN_AREA, today);
    expect(out.urgency).toBe(urgency);
    expect(out.nextAction).toBe(nextAction);
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it("out-of-area keeps the urgency but closes", () => {
    const out = triageRules(flags({ issueType: "no_heat", vulnerableOccupants: ["infant"] }), OUT_OF_AREA, WINTER);
    expect(out).toMatchObject({ urgency: "emergency", nextAction: "explain_and_close", serviceable: false, notServiceableReason: "out_of_area" });
    expect(out.reasons.at(-1)).toBe("ZIP 10025 is outside the service area");
  });

  it("commercial reason", () => {
    const out = triageRules(flags({ propertyType: "commercial" }), IN_AREA, WINTER);
    expect(out).toMatchObject({ serviceable: false, notServiceableReason: "residential_only" });
  });

  it("reasons are human-readable for the dashboard", () => {
    expect(triageRules(flags({ issueType: "no_heat", vulnerableOccupants: ["elderly", "medical_equipment"], indoorTempF: 52 }), IN_AREA, WINTER).reasons).toEqual([
      "No heat during heat season (Oct 1 to May 31) with vulnerable occupants: elderly, medical equipment",
      "No heat with indoor temperature 52°F (at or below 55°F)",
    ]);
    expect(triageRules(flags({ issueType: "no_cooling", vulnerableOccupants: ["elderly"] }), IN_AREA, WINTER).reasons).toEqual([
      "No cooling with vulnerable occupants: elderly (urgent in any season)",
    ]);
    expect(triageRules(flags({ issueType: "no_cooling", vulnerableOccupants: ["pregnant"] }), IN_AREA, SUMMER).reasons).toEqual([
      "No cooling with vulnerable occupants: pregnant, during cooling season (Jun 1 to Sep 30)",
    ]);
    expect(triageRules(flags({ issueType: "no_heat", vulnerableOccupants: ["medical_condition"] }), IN_AREA, SUMMER).reasons).toEqual([
      "No heat outside heat season with vulnerable occupants: medical condition",
    ]);
    expect(triageRules(flags({ gasSmell: true, coAlarm: true }), IN_AREA, WINTER).reasons).toEqual([
      "Caller reports a gas smell",
      "Carbon monoxide alarm reported",
    ]);
  });
});
