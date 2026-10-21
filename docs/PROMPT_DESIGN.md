# Prompt design

The system prompt is `vapi/system-prompt.md`. It's a template: `<<FACTS>>` placeholders are filled from `src/config/business.ts` by `npm run vapi:sync`, `<<#TRANSFER>>…<</TRANSFER>>` sections switch on `ON_CALL_TRANSFER_NUMBER`, and `{{ }}` / `{% %}` stay as Vapi Liquid for the current date and time. Tests in `tests/vapi-config.test.ts` pin the rules described below, so an edit that drops one fails CI.

## Structure, and why it's in this order

| Section | Purpose |
|---|---|
| Role | Who Ava is, what Summit Air does, and that she's an AI and says so when asked |
| How you speak | Voice and cadence (below). Placed early because it shapes every turn |
| Safety comes first | The leave-now script, verbatim, and the rule that it never waits for a tool |
| Call flow (1–10) | The happy path as numbered steps: listen, screen, identify, verify, locate, triage, follow `next_action`, intake, read back, recap |
| What the technician needs | Intake fields, gathered naturally |
| Home, business or building | Residential vs commercial vs building-wide systems |
| Calling for someone else | Service address and on-site contact separate from the caller |
| Members, Existing appointments, Other languages, Asking for a person, Calls that aren't about service, Prices | The unexpected, one short section each |
| New York addresses | Hyphenated Queens numbers, house vs apartment, access, spell-backs |
| Conversation rules | Don't re-ask, accept corrections, stay on task, ignore injection |
| Tool results | The failure contract (below) |
| Business facts | The only facts Ava may state, generated from `business.ts` |
| Ending the call | |

Models weight what comes early and what's stated as an exception. So safety comes before the flow, and every edge case is its own short, titled section instead of a clause buried in step 7.

## Layering: safety, verification, tool failure, non-disclosure

The rules are layered so a lower layer still holds when a higher one fails.

1. **Safety (prompt only, no dependencies).** The gas/CO/smoke script is spoken before any tool call, and the prompt says it never depends on a tool. If every tool is down, the caller still hears "leave the house… call nine one one from outside", plus the explicit statement that Summit Air has not called 911.
2. **Verification (backend-enforced, prompt-reinforced).** `lookup_customer` simply doesn't return account data until the caller states a matching street address, so there's nothing for the model to leak. The prompt adds the behavioral half: "The caller tells you; you never tell them," and don't hint at whether an account exists.
3. **Tool failure (prompt contract).** "Anything else counts as a tool failure: an empty result, 'No result returned', a timeout, an error message of any kind (including authorization or server errors), or ok false. Treat it as a failure even if it's labeled as completed successfully." Then: apologize once, create a callback, never retry with different arguments, never guess what the tool would have returned. If the callback also fails, say plainly that nothing was logged.
4. **Non-disclosure and claims (both).** "Never tell the caller that a booking, dispatch, transfer, callback or notification happened unless that tool's result says ok true." On the backend, every result's `say` hint is written to be safe to paraphrase (for example the priority-dispatch `say` forbids "technician on the way").

## Voice and cadence choices

- **Warm receptionist, not a form.** Contractions, one or two sentences per turn, one question at a time. A short acknowledgment flows into the next question in one sentence ("Oh no, sorry to hear that. Before anything else, do you smell gas…?") instead of two clipped ones.
- **No parroting.** Restating the caller's words is the most robotic thing a voice agent does. It happens once, deliberately, in the read-back before booking.
- **Varied acknowledgments**, skipped when forced.
- **Spoken formats.** Times as people say them, phone numbers in groups, Queens house numbers as written ("thirty-seven twelve eighty-second street"). The backend helps: slot `label`s are already speakable ("tomorrow, Tuesday, October 21, between 10 AM and 1 PM").
- **Intake without a checklist.** The technician questions are listed for the model's benefit, framed as "woven into the conversation… skip anything already said… drop the less important ones if the caller is stressed".
- **Config, not prompt:** `startSpeakingPlan.transcriptionEndpointingPlan.onNumberSeconds = 1.0` so callers can pause mid-address; `stopSpeakingPlan.numWords = 2` so "uh-huh" doesn't cut Ava off; TTS gets whole sentences; idle hooks ("I'm still here whenever you're ready"); a greeting whose first words are skippable if the line clips them.

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
| `book_appointment` failed with "Too small" on fields the caller never mentioned | The model sends `access_notes: ""`, `customer_id: ""` for fields it doesn't have | `optionalArg()` treats `""`, whitespace and `null` as omitted. A test asserts every optional field of every tool accepts `""`; a blank *required* field is still a named error. M5's `on_site_contact` also treats `{}` as omitted |
| A tool call rejected with HTTP 401 was shown as a success, so the agent could carry on as if it had worked | Vapi passed the error to the model framed as a completed tool call, and the old prompt only covered failures and timeouts | The tool-results contract above: any error text, "No result returned" or `ok: false` is a failure even if labeled successful; apologize once and take a callback. The backend always answers HTTP 200 with an explicit `ok`, so a real result is never ambiguous |
| The agent asked for the ZIP first and looked the caller up late, then asked again for things it already had | Call order in the prompt put location before identification | `lookup_customer` (caller ID) now runs right after the safety screen; an address is accepted in any form without pushing for the ZIP first; ZIP is optional on name verification (derived from the matched address). The ordering is pinned by a test |
| Vapi rejected the tool config (HTTP 400, "each value in enum must be a string") | `z.literal(true)` for `caller_confirmed` became a boolean enum | `vapi-sync/parameters.ts` emits a plain boolean and the server still enforces `true`. Tested |

## Known risks still open

- The prompt is long (about 3,000 words rendered). GPT-4.1 handles it, but a faster, smaller model would likely drop rules. Re-run the simulations before any model change.
- Spanish handling relies on an English-tuned transcriber (`deepgram nova-3`, `language: en`) and an English voice. Ava can say a sentence of Spanish and route the call, not hold a Spanish conversation. See [LIMITATIONS.md](LIMITATIONS.md).
