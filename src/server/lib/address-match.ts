// Compare a caller-stated street address with one on file, tolerating how
// people say NYC addresses: "thirty-seven twelve eighty-second street" = "37-12 82nd St",
// "four twelve seventh avenue" = "412 Seventh Ave", "one oh eight twenty" = "108-20".
// Pure; used for identity verification, so it errs on the side of "no match".

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};
const ZERO = new Set(["zero", "oh", "o"]);

// Street types are canonicalized and kept apart from the name: callers often omit
// them, but when both sides give one it must agree (Ocean Ave ≠ Ocean Pkwy).
const STREET_TYPES: Record<string, string> = {
  st: "st", street: "st", ave: "ave", av: "ave", avenue: "ave", rd: "rd", road: "rd",
  blvd: "blvd", boulevard: "blvd", pl: "pl", place: "pl", ter: "ter", terrace: "ter",
  ln: "ln", lane: "ln", dr: "dr", drive: "dr", ct: "ct", court: "ct", pkwy: "pkwy", parkway: "pkwy",
  way: "way", hwy: "hwy", highway: "hwy",
};
const DIRECTIONS: Record<string, string> = { north: "n", south: "s", east: "e", west: "w" };
const FILLER = new Set(["and", "the", "at", "on", "number"]);
// Everything after these is a unit, not the street.
const UNIT_MARKERS = /\b(apt|apartment|unit|suite|ste|floor|fl)\b|#/;

export type NormalizedAddress = { digits: string; words: string[]; type: string | null };

export function normalizeStreetAddress(input: string): NormalizedAddress {
  let s = input.toLowerCase().split(",")[0];
  const unitAt = s.search(UNIT_MARKERS);
  if (unitAt > 0) s = s.slice(0, unitAt);
  const tokens = s
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));

  const numbers: string[] = [];
  const words: string[] = [];
  let type: string | null = null;
  // Spoken-number grouping state: "thirty seven" is one group, "thirty seven twelve" is two.
  const g = { cur: null as number | null, hasHundred: false, hasTens: false, hasUnit: false };
  const flush = () => {
    if (g.cur !== null) numbers.push(String(g.cur));
    Object.assign(g, { cur: null, hasHundred: false, hasTens: false, hasUnit: false });
  };
  const start = (n: number, tens: boolean, unit: boolean) => {
    flush();
    Object.assign(g, { cur: n, hasTens: tens, hasUnit: unit });
  };
  const openAfterHundred = () => g.cur !== null && g.hasHundred && !g.hasTens && !g.hasUnit;

  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      flush();
      numbers.push(t);
    } else if (ZERO.has(t)) {
      flush();
      numbers.push("0");
    } else if (t in UNITS) {
      if (g.cur !== null && !g.hasUnit && (g.hasTens || g.hasHundred)) {
        g.cur += UNITS[t];
        g.hasUnit = true;
      } else start(UNITS[t], false, true);
    } else if (t in TEENS) {
      if (openAfterHundred()) {
        g.cur! += TEENS[t];
        g.hasUnit = g.hasTens = true;
      } else start(TEENS[t], true, true);
    } else if (t in TENS) {
      if (openAfterHundred()) {
        g.cur! += TENS[t];
        g.hasTens = true;
      } else start(TENS[t], true, false);
    } else if (t === "hundred" && g.cur !== null && !g.hasHundred && g.cur < 10) {
      g.cur *= 100;
      g.hasHundred = true;
      g.hasTens = g.hasUnit = false;
    } else {
      flush();
      if (t in STREET_TYPES) {
        type = STREET_TYPES[t];
        continue;
      }
      if (FILLER.has(t)) continue;
      words.push(DIRECTIONS[t] ?? t);
    }
  }
  flush();
  return { digits: numbers.join(""), words, type };
}

/** True when the spoken/typed address names the same house number and street as the stored line1. */
export function streetAddressMatches(stated: string, storedLine1: string): boolean {
  const a = normalizeStreetAddress(stated);
  const b = normalizeStreetAddress(storedLine1);
  if (!a.digits || !b.digits) return false;
  return (
    a.digits === b.digits &&
    a.words.join(" ") === b.words.join(" ") &&
    (a.type === null || b.type === null || a.type === b.type)
  );
}
