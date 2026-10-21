// Quick filters and search for the calls list. Pure; runs in the browser on the loaded rows.
import type { CallOutcome, CallStatus } from "./outcome";
import type { Urgency } from "@/server/repositories";

export type CallRowLite = {
  vapiCallId: string;
  at: string | null;
  callerName: string | null;
  callerPhone: string | null;
  issue: string | null;
  urgency: Urgency | null;
  outcome: CallOutcome;
  status: CallStatus;
};

export type CallFilter = { outcome: CallOutcome | "all"; urgency: Urgency | "all"; range: "today" | "7d" | "all"; q: string };

export const DEFAULT_FILTER: CallFilter = { outcome: "all", urgency: "all", range: "all", q: "" };

const digits = (s: string) => s.replace(/\D/g, "");

/** In-progress calls first (pinned), then the rest in their order. `todayStart` is local midnight. */
export function filterCalls<T extends CallRowLite>(rows: T[], f: CallFilter, now: number, todayStart: number): T[] {
  const q = f.q.trim().toLowerCase();
  const qDigits = digits(q);
  const out = rows.filter((r) => {
    if (f.outcome !== "all" && r.outcome !== f.outcome) return false;
    if (f.urgency !== "all" && r.urgency !== f.urgency) return false;
    const at = r.at ? Date.parse(r.at) : null;
    if (f.range === "today" && (at === null || at < todayStart)) return false;
    if (f.range === "7d" && (at === null || at < now - 7 * 86_400_000)) return false;
    if (q) {
      const name = (r.callerName ?? "").toLowerCase();
      const phone = digits(r.callerPhone ?? "");
      const byName = name.includes(q) || (r.issue ?? "").toLowerCase().includes(q);
      const byPhone = qDigits.length >= 3 && phone.includes(qDigits);
      if (!byName && !byPhone) return false;
    }
    return true;
  });
  return [...out.filter((r) => r.status === "in_progress"), ...out.filter((r) => r.status !== "in_progress")];
}
