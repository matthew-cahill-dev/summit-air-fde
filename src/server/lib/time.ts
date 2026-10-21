// Small time-zone helpers built on Intl (no date library).
// Keep this file free of path aliases: it is also compiled for the seed script.

export type CalendarDate = { year: number; month: number; day: number };

export function partsInZone(instant: Date, timeZone: string) {
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

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Local calendar date, hour and weekday of an instant in `timeZone`. */
export function localInfo(instant: Date, timeZone: string) {
  const p = partsInZone(instant, timeZone);
  const date: CalendarDate = { year: p.year, month: p.month, day: p.day };
  return { date, hour: p.hour, minute: p.minute, weekday: WEEKDAYS[dayOfWeek(date)] };
}

function hourLabel(hour: number, minute: number, withMeridiem: boolean): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const base = minute ? `${h12}:${String(minute).padStart(2, "0")}` : String(h12);
  return withMeridiem ? `${base} ${hour < 12 ? "AM" : "PM"}` : base;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Speakable arrival window, e.g. "Thursday, October 22, between 8 and 11 AM",
 * "tomorrow, Wednesday, October 21, between 10 AM and 1 PM".
 */
export function spokenWindow(startsAt: Date, endsAt: Date, timeZone: string, now?: Date): string {
  const s = localInfo(startsAt, timeZone);
  const e = localInfo(endsAt, timeZone);
  const sameDate = (a: CalendarDate, b: CalendarDate) => a.year === b.year && a.month === b.month && a.day === b.day;
  const weekday = s.weekday[0].toUpperCase() + s.weekday.slice(1);
  const dayPart = `${weekday}, ${MONTHS[s.date.month - 1]} ${s.date.day}`;
  // Without `now`, the label is absolute (for technician notes).
  const today = now ? todayInZone(timeZone, now) : null;
  const prefix = !today
    ? dayPart
    : sameDate(s.date, today)
      ? `today, ${dayPart}`
      : sameDate(s.date, addDays(today, 1))
        ? `tomorrow, ${dayPart}`
        : dayPart;
  const sameMeridiem = s.hour < 12 === e.hour < 12;
  const range = sameMeridiem
    ? `between ${hourLabel(s.hour, s.minute, false)} and ${hourLabel(e.hour, e.minute, true)}`
    : `between ${hourLabel(s.hour, s.minute, true)} and ${hourLabel(e.hour, e.minute, true)}`;
  return `${prefix}, ${range}`;
}
