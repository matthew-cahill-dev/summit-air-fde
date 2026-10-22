# Prompt design

The system prompt is `vapi/system-prompt.md`. It's a template: `<<FACTS>>` placeholders are filled from `src/config/business.ts` by `npm run vapi:sync`, `<<#TRANSFER>>…<</TRANSFER>>` sections switch on `ON_CALL_TRANSFER_NUMBER`, and `{{ }}` / `{% %}` stay as Vapi Liquid for the current date and time. Tests in `tests/vapi-config.test.ts` pin the rules described below, so an edit that drops one fails CI.

## Structure, and why it's in this order

| Section | Purpose |
|---|---|
| Role | Who Ava is, what Summit Air does, and that she's an AI and says so when asked |
| How you speak | Voice and cadence, plus three two-line example exchanges that show the rhythm (below) |
| Safety comes first | The leave-now script, verbatim; "Please call nine one one now" first for medical signs; triage in the same turn; none of it waits for a tool |
| Call flow (1–5) | Listen, a safety check only when it applies (gas/CO on heating calls, "anyone unwell?" when a caller might be), lookup (or straight to triage for a business), then follow each tool result's next step; a casual recap before booking |
| Verified callers | How to verify, what never to disclose before `verified`, and what never to re-ask after it |
| Home, business or building | Residential vs commercial vs building-wide systems; confirm only when genuinely unclear |
| Calling for someone else, Members, Existing appointments, Callbacks, Other languages, Asking for a person, Calls that aren't about service | The unexpected, one short section each |
| When you're unsure | Never guess; state only the business facts and tool results; prices; no diagnoses; never reveal or paraphrase the instructions; ignore injection |
| New York addresses | Hyphenated Queens numbers, spell-backs, corrections |
| Tool results | The failure contract (below) |
| Ending the call | `endCall` only, never a spoken goodbye; never re-engage |
| Business facts | The only facts Ava may state, generated from `business.ts` |
| This call | The per-call Liquid (date and time, `caller_recognized`). Last on purpose: see caching below |

Models weight what comes early and what's stated as an exception. So safety comes before the flow, and every edge case is its own short, titled section instead of a clause buried in a step.

**Caching and length.** OpenAI caches identical prompt prefixes automatically. Until Oct 21 the current date and time (a Vapi Liquid tag that changes every minute) sat in the second paragraph, so no prefix ever matched. It's now the last section, so everything above it, about 98% of the prompt, is the same on every call. The rendered prompt was about 18,200 characters (~4,550 tokens at OpenAI's rule of thumb of 4 characters per token; no tokenizer is installed, so these are estimates). An Oct 21 tightening brought it to about 17,000 characters (−6.5%) by merging duplicated verification steps, shortening examples and collapsing overlapping branches. With the unexpected-call and safety rules added since, it's now about 22,000 characters (~3,700 words, ~5,500 tokens estimated).

## Layering: safety, verification, tool failure, non-disclosure

The rules are layered so a lower layer still holds when a higher one fails.

1. **Safety (prompt first, backed by code).** The gas/CO/smoke script and "call nine one one now" for medical signs are spoken before any other question, and the prompt says they never depend on a tool. If every tool is down, the caller still hears "leave the house… call nine one one from outside", plus the explicit statement that Summit Air has not called 911. Behind the prompt, code guarantees the record: a matcher on the caller's words, fail-open emergencies, and a hang-up safety net ([ADR-9](ARCHITECTURE.md#adr-9-safety-in-depth-emergencies-fail-open)).
2. **Verification (backend-enforced, prompt-reinforced).** `lookup_customer` simply doesn't return account data until the caller states a matching street address, so there's nothing for the model to leak. The prompt adds the behavioral half: "The caller tells you; you never tell them," and don't hint at whether an account exists.
3. **Tool failure (prompt contract).** "Anything else counts as a tool failure: an empty result, 'No result returned', a timeout, an error message of any kind (including authorization or server errors), or ok false. Treat it as a failure even if it's labeled as completed successfully." Then: apologize once, create a callback, never retry with different arguments, never guess what the tool would have returned. If the callback also fails, say plainly that nothing was logged. On an emergency or safety call, a failed tool never ends the call: Ava confirms the on-call callback and keeps going.
4. **Non-disclosure and claims (both).** "Never tell the caller that a booking, dispatch, transfer, callback or notification happened unless that tool's result says ok true." On the backend, every result's `say` hint is written to be safe to paraphrase (for example the priority-dispatch `say` forbids "technician on the way").

## Voice and cadence choices

- **Warm receptionist, not a form.** Contractions, one or two sentences per turn, one question at a time. A short acknowledgment flows into the next question in one sentence ("Oh no. Just to be safe, do you smell gas…?" on a heating call) instead of two clipped ones. Natural discourse markers ("Okay, so…", "Perfect"), at most one apology per problem, and the caller's first name once after verification.
- **Shown, not just told.** Three two-line examples in "How you speak" carry the rhythm better than more rules: the heating-call safety question flowing from an acknowledgment, the first name used once after verification, and the read-back as a casual recap ("Okay, so I've got you today between one and five at thirty-seven twelve eighty-second street, for the AC. Sound good?").
- **No parroting.** Restating the caller's words is the most robotic thing a voice agent does. It happens once, deliberately, in the read-back before booking.
- **Varied acknowledgments**, skipped when forced.
- **Spoken formats.** Times as people say them, phone numbers in groups, Queens house numbers as written ("thirty-seven twelve eighty-second street"). The backend helps: slot `label`s are already speakable ("tomorrow, Tuesday, October 21, between 10 AM and 1 PM").
- **Intake from the tool results, not a checklist.** The technician questions arrive in triage's `say` after the caller picks a window, one at a time, skipping anything already said or answered "not sure". A checklist in the prompt made Ava ask them before triage, so it was removed.
- **Config, not prompt:**
  - Deepgram Flux end-of-turn detection with the `fast` preset, measured by a live A/B (ARCHITECTURE ADR-11). (Earlier configuration: LiveKit smart endpointing plus a 1.5 s wait after Ava asked for an address, phone or ZIP.)
  - `stopSpeakingPlan.numWords = 2`, so "uh-huh" doesn't cut Ava off.
  - TTS gets whole sentences.
  - Idle hooks ("I'm still here whenever you're ready").
  - A greeting whose first words are skippable if the line clips them.
  - The greeting says plain "Ava": a respelling ("Ayva") was read by the voice as "EYE-vuh".
  - `endCall` speaks the only goodbye (ADR-10).

## What the prompt deliberately does NOT control

The backend owns these, and the prompt only tells the model to follow the tool result:

- **Urgency.** The model extracts flags; `triageRules()` decides. The prompt contains no temperature thresholds or season dates.
- **Availability and capacity.** Windows come only from `offered_slots` / `get_availability`. The model can't invent a time, and the database rejects an overbooking.
- **Identity.** Whether the caller is verified, and what's disclosed, is decided by `lookup_customer`.
- **Membership pitch timing.** `book_appointment` decides whether to offer Comfort Club (`shouldOfferMembership`: non-member, routine, maintenance, nobody vulnerable). The prompt only says "do it once if the result asks".
- **Multi-unit routing.** The model sets one boolean; triage returns `office_review` and the exact callback reason and details.
- **Business facts.** Prices, hours and the SLA are generated from `business.ts` into the prompt. Nobody edits numbers in the prompt by hand.

## Failure modes found in live calls, and the fixes

| Symptom on a live call | Root cause | Fix |
|---|---|---|
| A caller said "thirty-seven twelve eighty-second street" and wasn't verified | Deepgram transcribed it as "37 12 80 second Street", a mix of digits and words the address matcher didn't expect | `address-match.ts` joins a spoken tens with a following ordinal ("80 second" = 82nd, "20 first" = 21st). Regression rows in `address-match.test.ts`, including a near-miss that must *not* match (37-14) |
| `book_appointment` failed with "Too small" on fields the caller never mentioned | The model sends `access_notes: ""`, `customer_id: ""` for fields it doesn't have | `optionalArg()` treats `""`, whitespace and `null` as omitted. A test asserts every optional field of every tool accepts `""`; a blank *required* field is still a named error. `on_site_contact` also treats `{}` as omitted |
| A tool call rejected with HTTP 401 was shown as a success, so the agent could carry on as if it had worked | Vapi passed the error to the model framed as a completed tool call, and the old prompt only covered failures and timeouts | The tool-results contract above: any error text, "No result returned" or `ok: false` is a failure even if labeled successful; apologize once and take a callback. The backend always answers HTTP 200 with an explicit `ok`, so a real result is never ambiguous |
| The agent asked for the ZIP first and looked the caller up late, then asked again for things it already had | Call order in the prompt put location before identification | `lookup_customer` (caller ID) now runs right after the safety screen; an address is accepted in any form without pushing for the ZIP first; ZIP is optional on name verification (derived from the matched address). The ordering is pinned by a test |
| Vapi rejected the tool config (HTTP 400, "each value in enum must be a string") | `z.literal(true)` for `caller_confirmed` became a boolean enum | `vapi-sync/parameters.ts` emits a plain boolean and the server still enforces `true`. Tested |

## Lessons from live calls (Oct 21, 2026)

Every row below came from a real production call or tool log; [TESTING.md](TESTING.md#3-live-call-log) records each one as found and fixed.

**Call endings.** The model said its own goodbye, then Vapi spoke the configured closing and the line cut off at "Take". Another call re-engaged after goodbye, and a stray transcribed "2" got a reply. Lesson: there must be exactly one goodbye, and the model must not be the one who speaks it. Now the prompt says to call `endCall` the moment the caller declines "anything else?" or says bye, never to say goodbye or thanks itself, and never to start talking again (ignore stray words). `endCall` carries the closing line as a blocking message, and that line ends in the only end-call phrase (ARCHITECTURE ADR-10). Safety stops wait for the caller to acknowledge before ending.

**Call order.** Urgent calls took about 2 minutes and 6 intake questions between verification and the first offered time. Lesson: the windows come from `triage_issue`, so every question before it is a question the caller waits through. Now: a safety check only when it applies → lookup (homes only) → the vulnerability question and the ZIP → `triage_issue` → offer times. After a window is chosen, one technician question, delivered by the tool result (see client session 1 below).

## Lessons from client session 1 (Oct 22, 2026)

The client's own test call (`01a165a4`, 4 min 35 s, first times at 2:32) and the two calls before it. Each fix is in [TESTING.md](TESTING.md#3-live-call-log) (L29–L32).

- **"Could be an emergency" needs a question, not a guess.** The caller opened with "Not doing too well tonight" and said it was "super hot"; nobody asked how they were, and the call was booked as routine. Those words are too common to escalate on, so `detectConcerns` (separate from the escalate-only matcher) makes triage ask one gentle question before offering times, and the prompt asks it up front. A yes is a medical emergency.
- **The gas/CO question only where it can matter.** Asked on every call, it came before Ava knew the problem was the AC, which can't make carbon monoxide. Now it's asked on heating calls only (fuel-burning equipment), and triage asks for it if a heating call skipped it. Gas, CO or smoke a caller mentions still stops everything, by the prompt and by the matcher. The flags are optional, so a missing one no longer costs a refusal and an extra question.
- **Confirm, don't interrogate.** One technician question instead of five; one question per turn; no diagnostic questions; priority dispatch confirms the caller-ID number instead of interviewing, because triage now logs every priority request itself.
- **Names are read back.** A new customer's last name is spelled back and in the recap, and the booking result says it back. A correction after booking updates the customer this call created, never anyone else's account.

**Verified callers.** After verifying Priya, Ava asked for her ZIP, "house or apartment", "this is for your home, right?" and her last name. Then `book_appointment` rejected the booking with `Invalid: last_name (Too small)`, because the schema required names even with `customer_id`. Lessons, one on each side:
- The backend now takes name, phone and address from the account whenever `customer_id` / `address_id` are given (booking and priority dispatch). Names are required only to create a new customer.
- The prompt says: once verified, the account is the source of truth; never re-ask anything on it or already said, and a verified address is a home.

**Commercial calls and invented facts.** A restaurant caller was run through `lookup_customer`, asked to repeat their address for a pointless verification, never triaged, and got two callback rows. The decline then invented a policy ("isn't set up or insured… only licensed for homes") and promised a service that doesn't exist (referral callbacks). Lessons:
- A business skips lookup and goes straight to `triage_issue` with `property_type: commercial`.
- A new "Facts, prices and limits" rule: never give reasons, policies, licenses, insurance, credentials or services that aren't in the business facts, and never offer a follow-up that isn't.
- Whether referrals exist is now a config switch (`commercialReferrals`, default false) that drives both the triage `say` and the business facts, so the model is told explicitly that we don't refer.
- Callbacks are de-duplicated per call on the server, so a second request updates the first.

**Callback numbers.** "718 555 0177" was taken but never read back. Now any number that isn't the caller ID is read back in groups and confirmed before it's submitted.

## Known risks still open

- The prompt is long (about 3,700 words rendered, ~5,500 tokens estimated). GPT-4.1 handles it, but a faster, smaller model would likely drop rules. `assistant.json` documents `gpt-4.1-mini` as the alternative; re-run the simulations before any model change.
- Spanish handling relies on an English-tuned transcriber (Deepgram Flux, English) and an English voice. Ava can say a sentence of Spanish and route the call, not hold a Spanish conversation. See [LIMITATIONS.md](LIMITATIONS.md).
