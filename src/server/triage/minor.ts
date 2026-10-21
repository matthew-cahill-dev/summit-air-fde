// Child-caller guard (docs/LIMITATIONS.md). Eval run 7021919d: a 9-year-old said "my mom is
// sleeping" and "I don't know my last name", and Ava booked a visit under "Leo". Pure and
// conservative: one strong sign, or a sleeping/absent parent plus a second, independent sign.
// Adults talk about their own children and parents ("my son is home", "my mom is elderly", "my
// kid", "my daughter is at school"); none of those phrasings match.

const WORD_AGES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};

// "I'm nine", "I am 12 years old", "I'm only 8." The age must end the clause or be followed by
// "years old" / "and", so "I'm 5 minutes away" or "I'm 12 floors up" never match.
const AGE = /\bi(?:'m| am) (?:only |just )?(\d{1,2}|[a-z]+)(?:\s*(?:years?|yrs?)(?:\s*old)?)?(?=\s*(?:[.,!?;]|$|and\b|years?\b))/gi;

const STRONG: RegExp[] = [
  /\bi(?:'m| am) in (?:the )?(?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) grade\b/i,
  /\bi(?:'m| am) in (?:kindergarten|elementary school|middle school)\b/i,
  /\bi(?:'m| am) (?:just |only )?a (?:little )?kid\b/i,
  /\bi (?:don't|do not|dunno) know (?:what )?my last name(?: is)?\b/i,
];

// A parent who is asleep or at work. "my" is optional: triage's caller_description is often
// paraphrased ("mom is sleeping").
const PARENT = "(?:mom|mommy|mum|mummy|mother|dad|daddy|father|parents|grown-?ups?)";
const WEAK: RegExp[] = [
  new RegExp(`\\b${PARENT}(?:'s| is| are)? (?:still |kind of |kinda )?(?:sleeping|asleep|napping|at work)\\b`, "i"),
  new RegExp(`\\b(?:should|can|could) i (?:go )?(?:get|wake(?: up)?) my ${PARENT}\\b`, "i"),
  new RegExp(`\\bi(?:'ll| will) go (?:get|wake(?: up)?) my ${PARENT}\\b`, "i"),
  new RegExp(`\\bmy ${PARENT} (?:said|told me) to call\\b`, "i"),
];

// The second, independent sign: the caller doesn't know basic household facts.
const DOESNT_KNOW =
  /\bi (?:don't|do not|dunno) know (?:the |my |our |what (?:the|my|our) )?(?:zip(?: code)?|address|phone number|number|last name)\b|\bnot sure (?:what|of) (?:the|my|our) zip\b/i;

export type MinorSigns = { minor: boolean; strong: string[]; weak: string[]; second: string[] };

function ageSign(text: string): string | null {
  for (const m of text.matchAll(AGE)) {
    const raw = m[1].toLowerCase();
    const age = /^\d+$/.test(raw) ? Number(raw) : WORD_AGES[raw];
    if (age !== undefined && age >= 3 && age <= 15) return m[0].trim();
  }
  return null;
}

/**
 * `text`: everything the caller said that the server can see (live caller lines, triage's
 * caller_description, booking details). `missingLastName`: an unverified booking with no last
 * name, which counts as a second sign.
 */
export function detectMinor(text: string, opts: { missingLastName: boolean }): MinorSigns {
  const strong = [ageSign(text), ...STRONG.map((re) => re.exec(text)?.[0] ?? null)].filter((s): s is string => Boolean(s));
  const weak = WEAK.map((re) => re.exec(text)?.[0] ?? null).filter((s): s is string => Boolean(s));
  const second = [DOESNT_KNOW.exec(text)?.[0] ?? null, opts.missingLastName ? "no last name given" : null].filter((s): s is string => Boolean(s));
  return { minor: strong.length > 0 || (weak.length > 0 && second.length > 0), strong, weak, second };
}
