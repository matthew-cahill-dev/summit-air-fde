// Display helpers for the operations console. Pure; time zone is always explicit.
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { JsonObject, Urgency } from "@/server/repositories";
import { localInfo, todayInZone, addDays } from "@/server/lib/time";

export const URGENCY_RANK: Record<Urgency, number> = { safety_stop: 0, emergency: 1, urgent: 2, routine: 3 };

export const URGENCY_LABEL: Record<Urgency, string> = {
  safety_stop: "Safety stop",
  emergency: "Emergency",
  urgent: "Urgent",
  routine: "Routine",
};

const ISSUE_LABEL: Record<string, string> = {
  no_heat: "No heat",
  no_cooling: "No cooling",
  maintenance: "Maintenance",
  noise: "Noise",
  leak: "Leak",
  thermostat: "Thermostat",
  other: "Other",
};

const VULNERABLE_LABEL: Record<string, string> = {
  elderly: "Elderly",
  infant: "Infant",
  medical_condition: "Medical condition",
  pregnant: "Pregnant",
  medical_equipment: "Medical equipment",
  disability: "Disability",
};

const CALLBACK_REASON_LABEL: Record<string, string> = {
  backend_failure: "System failure on call",
  out_of_area: "Out of service area",
  human_requested: "Asked for a person",
  incomplete_call: "Call incomplete",
  // Reschedules, language callbacks, building-wide systems, membership interest (details say which).
  other: "Office follow-up",
};

const SERVICE_LABEL: Record<string, string> = { maintenance: "Maintenance", repair: "Repair", diagnostic: "Diagnostic" };

const humanize = (v: string) => v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const issueLabel = (v: string | null | undefined) => (v ? (ISSUE_LABEL[v] ?? humanize(v)) : null);
export const vulnerableLabel = (v: string) => VULNERABLE_LABEL[v] ?? humanize(v);
export const callbackReasonLabel = (v: string | null | undefined) => (v ? (CALLBACK_REASON_LABEL[v] ?? humanize(v)) : "Callback");
export const serviceLabel = (v: string) => SERVICE_LABEL[v] ?? humanize(v);
export const toolLabel = (v: string) => v.replace(/_/g, " ");

export function isUrgency(v: unknown): v is Urgency {
  return typeof v === "string" && v in URGENCY_RANK;
}

/** "(718) 555-0101" for US numbers; anything else as stored. */
export function formatPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164, "US");
  if (!parsed) return e164;
  return parsed.country === "US" ? parsed.formatNational() : parsed.formatInternational();
}

const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export type DisplayAddress = { line1: string | null; unit: string | null; city: string | null; zip: string | null; accessNotes: string | null };

/** Address captured by a tool call (`{ line1, unit, city, zip, access_notes }`), if any part is present. */
export function readAddress(raw: unknown): DisplayAddress | null {
  if (!isObj(raw)) return null;
  const a: DisplayAddress = {
    line1: str(raw.line1),
    unit: str(raw.unit),
    city: str(raw.city),
    zip: str(raw.zip),
    accessNotes: str(raw.access_notes) ?? str(raw.accessNotes),
  };
  return Object.values(a).some(Boolean) ? a : null;
}

/** Vulnerable occupants wherever a record keeps them (dispatch intake, safety-stop flags, callback context). */
export function readVulnerable(...sources: unknown[]): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    if (!isObj(s)) continue;
    for (const holder of [s, s.flags, s.intake]) {
      if (!isObj(holder) || !Array.isArray(holder.vulnerable_occupants)) continue;
      for (const v of holder.vulnerable_occupants) if (typeof v === "string") out.add(v);
    }
  }
  return [...out];
}

// Safety-stop triggers, as triage flags and as the reason strings rules.ts writes.
const SAFETY_TRIGGERS = [
  { flag: "gas_smell", reason: "gas smell", label: "Gas smell" },
  { flag: "co_alarm", reason: "carbon monoxide alarm", label: "CO alarm" },
  { flag: "burning_smell_or_smoke", reason: "burning smell or smoke", label: "Smoke / burning smell" },
] as const;

/**
 * What triggered a safety stop ("Gas smell", "CO alarm", "Smoke / burning smell", joined with
 * " + " if several), from triage args, a dispatch's intake.flags, or the triage reasons.
 * Null when nothing safety-related was recorded. Safety stops are often typed issue "other",
 * so this replaces the issue label for them.
 */
export function safetyTriggerLabel(...sources: unknown[]): string | null {
  const found = new Set<string>();
  for (const s of sources) {
    if (Array.isArray(s)) {
      for (const r of s) {
        if (typeof r !== "string") continue;
        for (const t of SAFETY_TRIGGERS) if (r.toLowerCase().includes(t.reason)) found.add(t.label);
      }
      continue;
    }
    if (!isObj(s)) continue;
    for (const holder of [s, s.flags]) {
      if (!isObj(holder)) continue;
      for (const t of SAFETY_TRIGGERS) if (holder[t.flag] === true) found.add(t.label);
    }
  }
  const labels = SAFETY_TRIGGERS.map((t) => t.label).filter((l) => found.has(l));
  return labels.length ? labels.join(" + ") : null;
}

export function readIssueType(...sources: unknown[]): string | null {
  for (const s of sources) {
    if (!isObj(s)) continue;
    const t = str(s.issue_type) ?? (isObj(s.flags) ? str(s.flags.issue_type) : null);
    if (t) return t;
  }
  return null;
}

// --- Time -----------------------------------------------------------------------

const timeFmt = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const dateTimeFmt = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const sameDay = (a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }) =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/** "3:42 PM" today, "Yesterday 3:42 PM", otherwise "Oct 18, 3:42 PM" (all in `tz`). */
export function formatTimestamp(at: Date, tz: string, now: Date): string {
  const today = todayInZone(tz, now);
  const day = localInfo(at, tz).date;
  if (sameDay(day, today)) return timeFmt(tz).format(at);
  if (sameDay(day, addDays(today, -1))) return `Yesterday ${timeFmt(tz).format(at)}`;
  return dateTimeFmt(tz).format(at);
}

export function formatClock(at: Date, tz: string): string {
  return timeFmt(tz).format(at);
}

/** "8:00 – 10:00 AM", "10 AM – 1 PM" style arrival window. */
export function formatWindow(start: Date, end: Date, tz: string): string {
  const s = localInfo(start, tz);
  const e = localInfo(end, tz);
  const part = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  const mer = (h: number) => (h < 12 ? "AM" : "PM");
  return mer(s.hour) === mer(e.hour)
    ? `${part(s.hour, s.minute)} – ${part(e.hour, e.minute)} ${mer(e.hour)}`
    : `${part(s.hour, s.minute)} ${mer(s.hour)} – ${part(e.hour, e.minute)} ${mer(e.hour)}`;
}

/** "Today", "Tomorrow", or "Thursday, Oct 22" for a day heading. */
export function formatDayHeading(at: Date, tz: string, now: Date): string {
  const today = todayInZone(tz, now);
  const day = localInfo(at, tz).date;
  const long = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(at);
  if (sameDay(day, today)) return `Today · ${long}`;
  if (sameDay(day, addDays(today, 1))) return `Tomorrow · ${long}`;
  return long;
}

/** Calendar-day key in `tz` for grouping, e.g. "2026-10-21". */
export function dayKey(at: Date, tz: string): string {
  const d = localInfo(at, tz).date;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Compact elapsed time: "now", "4m", "1h 05m", "2d 3h". */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatDuration(start: Date | null, end: Date | null): string | null {
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
