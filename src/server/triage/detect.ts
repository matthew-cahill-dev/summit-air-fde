// Deterministic safety net: finds safety and medical signals in the CALLER's own words, so a
// missed model flag can't turn an emergency into a routine booking (eval run 1e753a02: "she's kind
// of confused and not making sense" was triaged as plain no-AC and booked). Pure and conservative:
// fixed phrases, negation-aware ("no gas smell", "not having trouble breathing" don't match),
// and only ever escalates. Used by triage_issue, book_appointment and the end-of-call check.

export type SignalKind = "medical" | "gas" | "co" | "smoke";
export type Signals = Record<SignalKind, string[]>;

const PERSON =
  "(?:she|he|they|her|him|them|mom|mother|dad|father|grand(?:mother|ma|father|pa)|husband|wife|son|daughter|baby|child|kid|kids|someone|everyone|nobody|partner|aunt|uncle|tenant|roommate)";

const PATTERNS: Record<SignalKind, RegExp[]> = {
  medical: [
    /\bnot making (?:any )?sense\b/i,
    /\bslurr(?:ing|ed) (?:her|his|their)? ?words?\b|\bslurred speech\b/i,
    /\b(?:dizzy|lightheaded|light-headed)\b/i,
    /\b(?:fainted|fainting|passed out|blacked out|collapsed|keeps? passing out)\b/i,
    /\b(?:unresponsive|not responding|won't wake up|can't wake (?:her|him|them) up)\b/i,
    /\b(?:not breathing|trouble breathing|hard time breathing|hard to breathe|can't breathe|cannot breathe|short of breath|struggling to breathe|gasping)\b/i,
    /\bchest pains?\b/i,
    /\bheat ?stroke\b|\bheat exhaustion\b/i,
    /\b(?:vomiting|throwing up)\b/i,
    /\b(?:very|really|extremely|so) weak\b/i,
    /\bhypotherm(?:ia|ic)\b|\b(?:lips|fingers) (?:are |turning |turned )?blue\b|\bshivering (?:uncontrollably|non-?stop|and can't stop)\b/i,
    /\bseizures?\b|\bhaving a seizure\b/i,
  ],
  gas: [/\bsmell(?:s|ing)? (?:of |like )?(?:natural )?gas\b/i, /\bgas (?:smell|odou?r|leak)\b/i, /\brotten eggs?\b/i, /\bsulph?ur\b/i],
  co: [/\b(?:co|carbon monoxide) (?:alarm|detector|monitor)s?\b/i, /\bcarbon monoxide\b/i],
  smoke: [/\bsmoke\b(?! (?:detector|alarm) (?:battery|chirp))/i, /\bsmoking\b/i, /\bburning (?:smell|odou?r)\b|\bsmells? (?:like )?(?:something )?burning\b|\bsomething(?:'s| is)? burning\b/i, /\b(?:sparks|sparking)\b/i],
};

// A clause-level negation right before the phrase cancels it: "there's no gas smell", "she isn't dizzy".
const NEGATION = /\b(?:no|not|never|without|nothing|none|neither|nor|nobody|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|haven't|hasn't|hadn't|no one)\b[^.,;!?]*$/i;

function negated(text: string, index: number): boolean {
  const clauseStart = Math.max(text.lastIndexOf(".", index), text.lastIndexOf(",", index), text.lastIndexOf(";", index), text.lastIndexOf("!", index), text.lastIndexOf("?", index), text.toLowerCase().lastIndexOf(" but ", index));
  const before = text.slice(clauseStart + 1, index);
  // Only the last few words of the clause count: "no alarm, but she's dizzy" isn't negated.
  const window = before.trim().split(/\s+/).slice(-5).join(" ");
  return NEGATION.test(window);
}

/** CO symptoms without an alarm: headaches plus dizziness or nausea in more than one person. */
const CO_SYMPTOMS = {
  headache: /\bheadaches?\b/i,
  other: /\b(?:dizzy|dizziness|nause(?:a|ous)|sick to (?:my|our|their) stomachs?|throwing up|vomiting)\b/i,
  several: /\b(?:we|we're|we all|all of us|everyone|everybody|both|the kids|the family|my (?:husband|wife|partner|kids|family) and (?:i|me)|us)\b/i,
};

// Confusion only about another person in the same clause ("she's just really hot and confused",
// "Grandpa seems disoriented"), never the caller ("I'm confused about the bill").
const CONFUSION = /\b(?:confused|disoriented|delirious|incoherent)\b/gi;
const PERSON_RE = new RegExp(`\\b${PERSON}\\b`, "i");

function findConfusion(text: string): string | null {
  for (const m of text.matchAll(CONFUSION)) {
    const index = m.index ?? 0;
    const clauseStart = Math.max(...[".", ",", ";", "!", "?"].map((c) => text.lastIndexOf(c, index)));
    const words = text.slice(clauseStart + 1, index).trim().split(/\s+/).filter(Boolean).slice(-7);
    const clause = words.join(" ");
    if (!PERSON_RE.test(clause) || /\b(?:i'm|i am|i was|i get)\b/i.test(words.slice(-3).join(" ")) || negated(text, index)) continue;
    return `${words.slice(-3).join(" ")} ${m[0]}`.trim();
  }
  return null;
}

function find(text: string, re: RegExp): string | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    if (!negated(text, m.index ?? 0)) return m[0].trim();
  }
  return null;
}

/** Every signal found, as the caller's own phrase. Empty arrays when nothing matched. */
export function detectSignals(text: string | null | undefined): Signals {
  const out: Signals = { medical: [], gas: [], co: [], smoke: [] };
  if (!text || !text.trim()) return out;
  const add = (kind: SignalKind, hit: string | null) => {
    const h = hit?.toLowerCase();
    // Keep the longest phrase: "carbon monoxide alarm" makes "carbon monoxide" redundant.
    if (h && !out[kind].some((x) => x.includes(h) || h.includes(x))) out[kind].push(h);
  };
  add("medical", findConfusion(text));
  for (const kind of Object.keys(PATTERNS) as SignalKind[]) {
    for (const re of PATTERNS[kind]) add(kind, find(text, re));
  }
  const headache = find(text, CO_SYMPTOMS.headache);
  const other = find(text, CO_SYMPTOMS.other);
  if (headache && other && CO_SYMPTOMS.several.test(text)) out.co.push(`${headache} + ${other}`.toLowerCase());
  return out;
}

export const hasSignals = (s: Signals) => s.medical.length + s.gas.length + s.co.length + s.smoke.length > 0;

/** The phrases as one list, most serious first ("gas: rotten eggs", "medical: confused"). */
export function signalPhrases(s: Signals): string[] {
  return (["gas", "co", "smoke", "medical"] as SignalKind[]).flatMap((k) => s[k].map((p) => `${k === "co" ? "CO" : k}: "${p}"`));
}

/** Only the caller's lines of a Vapi transcript ("User: …"); Ava's questions mention gas and CO on every call. */
export function callerLines(transcript: string | null | undefined): string {
  if (!transcript) return "";
  return transcript
    .split(/\r?\n/)
    .map((l) => /^(?:User|Customer|Caller)\s*:\s*(.*)$/i.exec(l.trim())?.[1] ?? null)
    .filter((l): l is string => l !== null)
    .join("\n");
}
