// Tiny chart math for the overview (no chart library): sparkline paths, day-over-day deltas,
// and the outcome mix for the stacked bar. Pure.
import { CALL_OUTCOMES, type CallOutcome } from "./outcome";

/** SVG path for a sparkline across `w`×`h`; nulls are skipped (the line bridges them). */
export function sparkPath(values: Array<number | null>, w: number, h: number, pad = 2): string {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length === 0) return "";
  const max = Math.max(...pts.map((p) => p[1]));
  const min = Math.min(...pts.map((p) => p[1]));
  const span = max - min || 1;
  const x = (i: number) => (values.length <= 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - 2 * pad));
  const y = (v: number) => (max === min ? h / 2 : h - pad - ((v - min) / span) * (h - 2 * pad));
  return pts.map(([i, v], k) => `${k === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
}

export type Delta = { text: string; direction: "up" | "down" | "flat" } | null;

/** Today vs yesterday: "+3", "−20%", "same as yesterday". Null when there's nothing to compare. */
export function dayDelta(today: number | null, yesterday: number | null, mode: "count" | "percent" = "count"): Delta {
  if (today === null || yesterday === null) return null;
  const diff = today - yesterday;
  if (diff === 0) return { text: "same as yesterday", direction: "flat" };
  const direction = diff > 0 ? "up" : "down";
  if (mode === "percent") {
    if (yesterday === 0) return null;
    return { text: `${diff > 0 ? "+" : "−"}${Math.round((Math.abs(diff) / yesterday) * 100)}% vs yesterday`, direction };
  }
  return { text: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} vs yesterday`, direction };
}

export type OutcomeSlice = { outcome: CallOutcome; count: number; percent: number };

/** Outcome counts in the console's fixed order, with percentages that add to 100 (largest remainder). */
export function outcomeBreakdown(outcomes: CallOutcome[]): OutcomeSlice[] {
  const total = outcomes.length;
  const counts = CALL_OUTCOMES.map((o) => ({ outcome: o, count: outcomes.filter((x) => x === o).length }));
  if (total === 0) return counts.map((c) => ({ ...c, percent: 0 }));
  const raw = counts.map((c) => ({ ...c, exact: (c.count / total) * 100 }));
  const floored = raw.map((r) => ({ ...r, percent: Math.floor(r.exact) }));
  let left = 100 - floored.reduce((s, r) => s + r.percent, 0);
  for (const r of [...floored].sort((a, b) => b.exact - b.percent - (a.exact - a.percent))) {
    if (left <= 0) break;
    if (r.count > 0) {
      r.percent++;
      left--;
    }
  }
  return floored.map(({ outcome, count, percent }) => ({ outcome, count, percent }));
}
