// Deterministic triage. Pure: no I/O, no clock. The model extracts flags; these
// rules decide urgency and the next step. Thresholds live in src/config/business.ts.
import { BUSINESS, isInSeason, type Season, type VulnerableOccupant } from "@/config/business";
import type { CalendarDate } from "@/server/lib/time";

export const ISSUE_TYPES = ["no_heat", "no_cooling", "maintenance", "noise", "leak", "thermostat", "other"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const VULNERABLE_OCCUPANTS = [
  "elderly",
  "infant",
  "medical_condition",
  "pregnant",
  "medical_equipment",
  "disability",
] as const satisfies readonly VulnerableOccupant[];

export type Urgency = "safety_stop" | "emergency" | "urgent" | "routine";
export type NextAction =
  | "safety_instructions"
  | "priority_dispatch"
  | "book_earliest"
  | "book_standard"
  | "explain_and_close"
  | "create_callback";

export type TriageFlags = {
  issueType: IssueType;
  gasSmell: boolean;
  coAlarm: boolean;
  burningSmellOrSmoke: boolean;
  vulnerableOccupants: readonly VulnerableOccupant[];
  indoorTempF?: number;
  propertyType: "residential" | "commercial";
};

export type ServiceAreaInfo = { zip: string; inArea: boolean; county: string | null };

export type TriageConfig = {
  heatSeason: Season;
  coolingSeason: Season;
  noHeatEmergencyMaxIndoorTempF: number;
  noCoolingEmergencyMinIndoorTempF: number;
  coolingMedicalVulnerabilities: readonly VulnerableOccupant[];
  residentialOnly: boolean;
};

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  heatSeason: BUSINESS.heatSeason,
  coolingSeason: BUSINESS.coolingSeason,
  noHeatEmergencyMaxIndoorTempF: BUSINESS.triage.noHeatEmergencyMaxIndoorTempF,
  noCoolingEmergencyMinIndoorTempF: BUSINESS.triage.noCoolingEmergencyMinIndoorTempF,
  coolingMedicalVulnerabilities: BUSINESS.triage.coolingMedicalVulnerabilities,
  residentialOnly: BUSINESS.residentialOnly,
};

export type TriageDecision = {
  urgency: Urgency;
  /** Human-readable, shown on the dashboard. */
  reasons: string[];
  nextAction: NextAction;
  serviceable: boolean;
  notServiceableReason?: "residential_only" | "out_of_area";
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const seasonLabel = (s: Season) =>
  `${MONTH_ABBR[s.start.month - 1]} ${s.start.day} to ${MONTH_ABBR[s.end.month - 1]} ${s.end.day}`;
const occupantLabel = (o: readonly string[]) => o.map((v) => v.replace(/_/g, " ")).join(", ");

export function triageRules(
  flags: TriageFlags,
  area: ServiceAreaInfo,
  today: CalendarDate,
  config: TriageConfig = DEFAULT_TRIAGE_CONFIG,
): TriageDecision {
  const reasons: string[] = [];
  const temp = flags.indoorTempF;
  const heatSeason = isInSeason(config.heatSeason, today.month, today.day);
  const coolingSeason = isInSeason(config.coolingSeason, today.month, today.day);

  const commercial = flags.propertyType === "commercial" && config.residentialOnly;
  const serviceable = !commercial && area.inArea;
  const notServiceableReason = commercial ? "residential_only" : !area.inArea ? "out_of_area" : undefined;

  // 1. Safety stop overrides everything, including serviceability.
  if (flags.gasSmell) reasons.push("Caller reports a gas smell");
  if (flags.coAlarm) reasons.push("Carbon monoxide alarm reported");
  if (flags.burningSmellOrSmoke) reasons.push("Burning smell or smoke reported");
  if (reasons.length) {
    return { urgency: "safety_stop", reasons, nextAction: "safety_instructions", serviceable, notServiceableReason };
  }

  // 2. Urgency from the issue.
  let urgency: Urgency = "routine";
  const vulnerable = flags.vulnerableOccupants;
  const medicallyVulnerable = vulnerable.filter((v) => config.coolingMedicalVulnerabilities.includes(v));

  if (flags.issueType === "no_heat") {
    if (heatSeason && vulnerable.length > 0) {
      urgency = "emergency";
      reasons.push(`No heat during heat season (${seasonLabel(config.heatSeason)}) with vulnerable occupants: ${occupantLabel(vulnerable)}`);
    }
    if (temp !== undefined && temp <= config.noHeatEmergencyMaxIndoorTempF) {
      urgency = "emergency";
      reasons.push(`No heat with indoor temperature ${temp}°F (at or below ${config.noHeatEmergencyMaxIndoorTempF}°F)`);
    }
    if (urgency !== "emergency") {
      if (heatSeason) {
        urgency = "urgent";
        reasons.push(`No heat during heat season (${seasonLabel(config.heatSeason)})`);
      } else if (vulnerable.length > 0) {
        // Requirement: a vulnerable occupant makes no heat at least urgent in any season.
        urgency = "urgent";
        reasons.push(`No heat outside heat season with vulnerable occupants: ${occupantLabel(vulnerable)}`);
      } else {
        reasons.push("No heat outside heat season");
      }
    }
  } else if (flags.issueType === "no_cooling") {
    const hot = temp !== undefined && temp >= config.noCoolingEmergencyMinIndoorTempF;
    if (medicallyVulnerable.length > 0 && (coolingSeason || hot)) {
      urgency = "emergency";
      reasons.push(
        `No cooling with medically vulnerable occupants: ${occupantLabel(medicallyVulnerable)}` +
          (hot
            ? `, indoor temperature ${temp}°F (at or above ${config.noCoolingEmergencyMinIndoorTempF}°F)`
            : `, during cooling season (${seasonLabel(config.coolingSeason)})`),
      );
    } else if (vulnerable.length > 0) {
      // Requirement: no AC with a vulnerable occupant (elderly, medical condition, ...) is at
      // least urgent regardless of season.
      urgency = "urgent";
      reasons.push(
        `No cooling with vulnerable occupants: ${occupantLabel(vulnerable)}` +
          (coolingSeason ? `, during cooling season (${seasonLabel(config.coolingSeason)})` : " (urgent in any season)"),
      );
    } else if (coolingSeason) {
      urgency = "urgent";
      reasons.push(`No cooling during cooling season (${seasonLabel(config.coolingSeason)})`);
    } else {
      reasons.push("No cooling outside cooling season");
    }
  } else if (flags.issueType === "leak") {
    urgency = "urgent";
    reasons.push("Active leak reported");
  } else {
    reasons.push(`Routine request: ${flags.issueType.replace(/_/g, " ")}`);
  }

  // 3. Serviceability decides whether we can act on it.
  if (!serviceable) {
    reasons.push(
      notServiceableReason === "residential_only"
        ? "Commercial property: Summit Air services homes only"
        : `ZIP ${area.zip} is outside the service area`,
    );
    return { urgency, reasons, nextAction: "explain_and_close", serviceable, notServiceableReason };
  }

  const nextAction: NextAction =
    urgency === "emergency" ? "priority_dispatch" : urgency === "urgent" ? "book_earliest" : "book_standard";
  return { urgency, reasons, nextAction, serviceable };
}
