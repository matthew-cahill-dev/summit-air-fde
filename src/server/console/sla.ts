// The live SLA countdown on the dispatch board. Pure and import-free: it runs in the browser.

export type SlaState = { label: string; overdue: boolean; /** 0..1 of the SLA used, capped at 1. */ used: number };

const mmss = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** "Callback due in 11:42" → "Overdue 3:10"; acknowledged items show how long ago. Ticks every second on the client. */
export function slaCountdown(createdAtMs: number, slaMinutes: number, nowMs: number, acknowledgedAtMs: number | null = null): SlaState {
  const dueAt = createdAtMs + slaMinutes * 60_000;
  const used = Math.min(1, Math.max(0, (nowMs - createdAtMs) / (slaMinutes * 60_000)));
  // "Called back" stops the customer-facing SLA clock.
  if (acknowledgedAtMs !== null) return { label: `Called back ${mmss(nowMs - acknowledgedAtMs)} ago`, overdue: false, used };
  if (nowMs <= dueAt) return { label: `Callback due in ${mmss(dueAt - nowMs)}`, overdue: false, used };
  return { label: `Overdue ${mmss(nowMs - dueAt)}`, overdue: true, used: 1 };
}
