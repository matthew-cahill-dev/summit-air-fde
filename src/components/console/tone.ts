// One semantic color system for the console. Every badge, rail, dot and chart segment maps an
// urgency or outcome to a Tone, so "safety stop" is the same red on the board, in the calls list,
// on the timeline and in the overview bar. Class strings are literal so Tailwind can see them.
import type { CallOutcome } from "@/server/console/outcome";
import type { Urgency } from "@/server/repositories";

export type Tone = "safety" | "emergency" | "urgent" | "routine" | "booked" | "coverage" | "callback" | "neutral";

export const URGENCY_TONE: Record<Urgency, Tone> = {
  safety_stop: "safety",
  emergency: "emergency",
  urgent: "urgent",
  routine: "routine",
};

export const OUTCOME_TONE: Record<CallOutcome, Tone> = {
  safety_stop: "safety",
  priority_dispatch: "emergency",
  booked: "booked",
  coverage_check: "coverage",
  callback: "callback",
  not_serviceable: "neutral",
  incomplete: "neutral",
};

/** Soft badge: tinted background, readable ink, hairline ring. */
export const TONE_BADGE: Record<Tone, string> = {
  safety: "bg-safety-soft text-safety-ink ring-1 ring-inset ring-safety/30",
  emergency: "bg-emergency-soft text-emergency-ink ring-1 ring-inset ring-emergency/30",
  urgent: "bg-urgent-soft text-urgent-ink ring-1 ring-inset ring-urgent/40",
  routine: "bg-routine-soft text-routine-ink ring-1 ring-inset ring-routine/25",
  booked: "bg-success-soft text-success-ink ring-1 ring-inset ring-success/30",
  coverage: "bg-coverage-soft text-coverage-ink ring-1 ring-inset ring-coverage/30",
  callback: "bg-callback-soft text-callback-ink ring-1 ring-inset ring-callback/30",
  neutral: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
};

/** Solid fill: rails, dots, chart segments. */
export const TONE_FILL: Record<Tone, string> = {
  safety: "bg-safety",
  emergency: "bg-emergency",
  urgent: "bg-urgent",
  routine: "bg-routine",
  booked: "bg-success",
  coverage: "bg-coverage",
  callback: "bg-callback",
  neutral: "bg-muted-foreground/40",
};

/** Text in the tone's ink, for icons and emphasis. */
export const TONE_TEXT: Record<Tone, string> = {
  safety: "text-safety-ink",
  emergency: "text-emergency-ink",
  urgent: "text-urgent-ink",
  routine: "text-routine-ink",
  booked: "text-success-ink",
  coverage: "text-coverage-ink",
  callback: "text-callback-ink",
  neutral: "text-muted-foreground",
};

/** Icon chip background for timeline steps and activity rows. */
export const TONE_CHIP: Record<Tone, string> = {
  safety: "bg-safety-soft text-safety-ink",
  emergency: "bg-emergency-soft text-emergency-ink",
  urgent: "bg-urgent-soft text-urgent-ink",
  routine: "bg-routine-soft text-routine-ink",
  booked: "bg-success-soft text-success-ink",
  coverage: "bg-coverage-soft text-coverage-ink",
  callback: "bg-callback-soft text-callback-ink",
  neutral: "bg-muted text-muted-foreground",
};
