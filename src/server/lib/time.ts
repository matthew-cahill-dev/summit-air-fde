// Small time-zone helpers built on Intl (no date library).
// Keep this file free of path aliases: it is also compiled for the seed script.

export type CalendarDate = { year: number; month: number; day: number };

function partsInZone(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Today's calendar date in `timeZone`. */
export function todayInZone(timeZone: string, now: Date = new Date()): CalendarDate {
  const p = partsInZone(now, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC instant for a wall-clock time in `timeZone` (DST-aware). */
export function zonedTimeToUtc(date: CalendarDate, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Two passes handle the offset changing across a DST boundary.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(new Date(guess), timeZone);
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = guess + (asUtc - wallAsUtc);
  }
  return new Date(guess);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The next `count` Mon–Fri dates strictly after `from`. */
export function nextBusinessDays(from: CalendarDate, count: number): CalendarDate[] {
  const out: CalendarDate[] = [];
  let cursor = from;
  while (out.length < count) {
    cursor = addDays(cursor, 1);
    const dow = dayOfWeek(cursor);
    if (dow !== 0 && dow !== 6) out.push(cursor);
  }
  return out;
}
