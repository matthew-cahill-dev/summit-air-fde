# Testing

Three layers: an automated suite (backend and prompt text), Vapi simulations (model behavior, chat transport, costs credits) and live phone calls (the real thing).

## 1. Automated suite

`npm test` runs Vitest against a **real Postgres test database** (`summit_air_test`, created, migrated and seeded by `tests/global-setup.ts`). The logic most likely to break is SQL: the atomic seat claim, `ON CONFLICT` idempotency, the end-of-call upsert. Mocked repositories would only test the mocks. Pure logic (triage, slot selection, address matching, notes) has plain unit tests.

Slot tests are deterministic: test windows sit on fixed weekdays of the first full week the seed covers, and booking tests pin the clock to that Monday at 06:00 (`slotFactory` / `TEST_NOW` in `tests/helpers.ts`). Results don't depend on the day or hour the suite runs.

**Last run: 390 tests in 28 files, all passing** (`npm test`, Oct 21, 2026, about 8 s locally).

| Area | Files | Tests |
|---|---|---|
| Triage and safety rules | `triage-rules`, `triage-tool` | 47 |
| Identity and verification | `caller-context`, `address-match`, `phone`, `demo-alias-and-reset` | 77 |
| Scheduling and booking | `booking`, `slot-selection`, `service-area` | 28 |
| Priority dispatch and callbacks | `dispatch-callback` | 3 |
| M5 requirement gaps (intake, multi-unit, membership, calling for someone else, next appointment, language) | `m5-requirements` | 24 |
| Live-call fixes (verified callers' account data, one callback per call, property type, commercial declines) | `live-call-fixes` | 19 |
| Tools endpoint robustness (auth, envelope, blank args, idempotency keys, timing) | `tools-endpoint`, `envelope`, `blank-optional-args`, `canonical-json`, `tool-timing`, `auth` | 42 |
| Vapi config, prompt rules (incl. call order, call endings, endpointing, pronunciation), sync and evals | `vapi-config`, `vapi-sync`, `evals`, `assistant-request` | 73 |
| Events and keep-warm | `events`, `keep-warm` | 13 |
| Operations console (board, call outcome, safety-stop labels, seed never in progress, session auth, 404 for unknown calls) | `console-board`, `call-outcome`, `dashboard-auth` | 57 |
| Environment validation | `env` | 7 |
| **Total** | **28 files** | **390** |

What the suite does **not** prove: that the model follows the prompt. `vapi-config.test.ts` checks that the rules are *in* the prompt; only simulations and live calls show whether Ava obeys them.

## 2. Vapi simulations (`npm run evals`)

Twelve scenarios in `vapi/simulations/*.json`, one or more per requirement plus the edge cases. Each has caller instructions (the simulated caller's facts and goal) and yes/no checks that a Vapi judge model answers from the transcript.

| id | Requirement | What it checks |
|---|---|---|
| `a-new-customer-tuneup` | a, d, f | Safety screen, one question at a time, read-back, booking, membership mentioned at most once |
| `b-commercial-caller` | b | Recognized as commercial, declined warmly, no booking |
| `b-multi-unit-building` | b | Building boiler goes to office review, not booked |
| `c-member-lookup` | c | No details before verification, greeted by first name, brief member benefit, booked |
| `d-calling-for-mother` | d, e | Occupant's age considered, on-site contact collected, not blocked by verification, clear next step |
| `e-gas-smell` | e | Leave now, 911 from outside, no switches, no booking |
| `e-no-heat-elderly` | e | Priority, callback policy stated, no "technician on the way" |
| `e-no-ac-medical` | e | Medical condition considered, urgent handling, no diagnosis |
| `f-reschedule` | f, unexpected | Verified first, doesn't claim it changed the booking, office will confirm |
| `unexpected-spanish-speaker` | unexpected | Some Spanish, callback in Spanish, no English-only dead end |
| `unexpected-prompt-injection` | unexpected, quality | No prompt leak, no customer data, no invented discount, stays polite |
| `unexpected-correction-after-readback` | unexpected, quality | Corrected address read back again and booked; no full restart |

```bash
npm run evals                         # validate + list scenarios + estimated cost; sends nothing
npm run evals -- --confirm            # upsert scenarios in Vapi, run them (chat), print PASS/FAIL per scenario
npm run evals -- --confirm --only e-gas-smell,b-commercial-caller
npm run evals -- --confirm --voice    # voice transport, roughly 10x the cost
```

- **Needs** `VAPI_API_KEY` and `VAPI_ASSISTANT_ID` in `.env`.
- **Cost:** the script prints an estimate (about $0.10 a scenario on chat, about $1 on voice). Vapi doesn't publish simulation pricing; these numbers are assumptions in `src/vapi-sync/evals.ts`.
- **Tools run for real** against the live backend: bookings, callbacks and dispatches land in production. Afterwards run `npm run db:reset-test -- --confirm`.
- **No caller ID on chat.** Vapi simulations don't put a test number in the webhook's `call.customer`, so `lookup_customer` sees no caller ID. Scenarios verify by last name and street, and give a phone number when asked.
- **Status: built and validated locally (`npm run evals` dry run); not yet run against the live assistant.** Endpoints and field names were checked against Vapi's OpenAPI spec (`/eval/simulation/scenario`, `/eval/simulation/personality`, `/eval/simulation/run`, `/eval/simulation/run/{id}/item`) on Oct 20, 2026, but no request has been sent, so the first `--confirm` run is the real test of the integration.

## 3. Latency measurement (`npm run call-report`)

```bash
npm run call-report -- latest --last 3     # the 3 most recent ended calls on VAPI_ASSISTANT_ID
npm run call-report -- <vapiCallId>        # one call
npm run call-report -- latest --json       # machine-readable
```

Read-only (`GET /call`, `GET /call/{id}`). For each caller turn it prints:
- the **wait**: caller stops talking (`endTime` of the caller's last fragment) → Ava starts (`time` of her next message, including a tool filler);
- the tools called and their durations as Vapi saw them (call → result);
- Vapi's own breakdown from `artifact.performanceMetrics.turnLatencies`: endpointing, transcriber, model (time to first token), voice (time to first audio) and turn total;
- p50 / p95 / max with and without tools; overlaps (negative waits, when someone barged in) are counted separately so they don't flatter the median;
- the ended reason, the last assistant message and the recording URL.

The console stores each call's median and p95 wait from the end-of-call report and shows them on the call page and as the Overview KPI "Median response time".

### Before and after (one call per row, default config)

| When | Config | Waits p50 / p95 | Ava cut-ins / caller barge-ins | Ending |
|---|---|---|---|---|
| Oct 20 night (`01a15cfc`) | LiveKit "Conservative" + 1.5 s digit rule, nova-3 | 2030 / 3180 ms | — | goodbye clipped on the phone |
| Oct 21 morning (`01a15e9b`) | Flux 0.7 / 3000, wait 0.3 | **1504 / 2065 ms** | 1 / 4 | full goodbye; line dropped 3.1 s after it |
| After this batch | Flux 0.8 / 4000 (`safe`), wait 0.2, 10-min DB pool idle, short turns | TBD | TBD | target: line drops ~1.5 s after the goodbye |

call-report now also reads Vapi's per-call log (`artifact.presignedLogUrl`). For each tool it prints the webhook round trip as Vapi measured it, plus the filler's speech window. For the ending it prints when the goodbye started and stopped and when the line was actually torn down. Until Oct 21 the interruption line had Vapi's two counters swapped; it now reads "Ava cut in on the caller N×; caller barged in on Ava M×".

### Baseline before the Oct 21 latency fix (3 live calls)

| Call (Vapi ID prefix, config) | Waits p50 / p95 | Vapi endpointing p50 / p95 | Transcriber p50 / p95 | Model (TTFT) p50 / p95 | Voice p50 / p95 |
|---|---|---|---|---|---|
| `01a15cfc` (LiveKit "Conservative", 1.5 s rule) | **2030 / 3180 ms** | 727 / 2250 ms | 500 / 2699 ms | 515 / 1032 ms | 234 / 267 ms |
| `01a15cca` (transcription endpointing 0.1 s) | 1360 / 4120 ms | 102 / 1502 ms | 242 / 3715 ms | 595 / 3671 ms | 232 / 668 ms |
| `01a15cc2` (transcription endpointing 0.1 s) | 1270 / 2240 ms | 101 / 621 ms | 315 / 3211 ms | 597 / 833 ms | 228 / 279 ms |
| **All 3 calls** | **1650 / 3500 ms** (n=57) | | | | |

Tool turns, from the raw messages:
- The tool filler starts 1.0–1.35 s after the model's `tool_calls` message, every time, even for `lookup_customer {}`.
- Vapi receives the result 1.0–2.5 s after the call, while our handler logs 58–324 ms.
- `endCall`: the hang-up result lands 147–672 ms *before* the goodbye audio ends.

## 3. Live call log

### Found in live production calls and fixed (Oct 21, 2026)

Evidence is quoted from real call transcripts and production tool logs. **Status for every row: fixed in this commit, not yet re-tested on a live call.** Re-run the matching scenario below and record the result in the template.

| # | Live evidence | Fix | Covered by |
|---|---|---|---|
| L1 | Verified member Priya: `book_appointment` → `Invalid: last_name (Too small...)`, so Ava asked for her last name | With `customer_id`, name and phone come from the account (booking and priority dispatch; `address_id` for the address). Names are required only for a new customer, named per field | `live-call-fixes`: "verified callers are never asked for data on the account" |
| L2 | After verifying Priya, Ava asked the ZIP, "house or apartment", "this is for your home, right?" and her last name | Prompt "Verified callers": the account is the source of truth; never re-ask anything on it or already said | `vapi-config`: "verified callers are never re-asked…" |
| L3 | "The AC at our restaurant": `lookup_customer` ran, the caller repeated the address for a pointless verification, `triage_issue` never ran, and two `create_callback_request` rows were created | Prompt: a business skips lookup and goes straight to `triage_issue` (commercial). Server: one open callback per call (advisory-locked upsert) | `vapi-config`: call order; `live-call-fixes`: "callbacks: one per call" |
| L4 | Decline invented "isn't set up or insured… only licensed for homes" and promised "the office can call you back with recommendations for commercial HVAC companies" | `commercialReferrals` (default false) drives the triage `say` and business facts ("we don't refer them"); prompt forbids reasons, policies, credentials or services not in the facts | `live-call-fixes`: "commercial callers"; `vapi-config`: "no invented facts…" |
| L5 | Adding a preferred time created a second callback row | Same-call requests update the open callback (same id, `updated: true`); new `preferred_callback_time`, shown on the board | `live-call-fixes`: "callbacks: one per call" |
| L6 | "718 555 0177" was taken as a callback number and never read back | Prompt "Callbacks": any number that isn't the caller ID is read back in groups and confirmed first; the tool description says so too | `vapi-config`: "callbacks: one per call, preferred time, new numbers read back" |
| L7 | Urgent call: about 2 minutes and 6 intake questions between verification and triage | New call order: safety → lookup (homes only) → address/ZIP + vulnerability → `triage_issue` immediately → times; at most 2 intake questions before times (1–2 for priority dispatch) | `vapi-config`: "call order: …" |
| L8 | After "not sure" about the equipment, Ava still asked for error codes | Prompt: "not sure" drops the topic and its follow-ups | `vapi-config`: technician intake |
| L9 | Ava said "Take care", then "Thank you. Goodbye."; the caller asked "Are you gonna hang up?"; the closing cut off at "Take" | The model never says goodbye; it calls `endCall`, whose blocking message is the only goodbye and ends in the only end-call phrase | `vapi-config`: "call endings: …" |
| L10 | Re-engaged after goodbye; a stray transcribed "2" got "If you meant to press a button…" | Prompt: never start talking again after a goodbye; ignore stray words, numbers or noises. `endCall` ends the call right after the closing line | `vapi-config`: "call endings: …" |
| L11 | Cut in mid-utterance: "Frustrating. Oh, that's frustrating." while the caller was still talking | LiveKit smart endpointing (conservative curve), 1.5 s after asking for digits, looser fallback values | `vapi-config`: "turn-taking: …" |
| L13 | Long pauses before Ava answers: waits p50 **2.03 s** / p95 3.18 s on the "Conservative" endpointing config | Root causes from `call-report`: endpointing p50 727 ms (700 ms curve floor + 1.5 s rule), transcriber p95 2.7 s (nova-3), model TTFT ~0.5 s. Now Deepgram Flux end-of-turn, `waitSeconds` 0.3, no post-question wait, `minCharacters` 5 + short opener sentence, 24 h prompt cache, shorter fillers, model A/B variants | `vapi-config`: "turn-taking: Deepgram Flux…"; `variants` |
| L14 | Goodbye still cut off on the phone, although **the recording has the full goodbye** | Recording complete, phone path clipped → tail padding. `call-report` showed the hang-up 0.15–0.67 s before the goodbye audio ended. Now `phone-call-control`: we wait 1.5 s, then end the call via `monitor.controlUrl`, on every ending path | `call-control` (8 tests, incl. "every ending path uses the same padded hang-up") |
| L15 | Filler "One sec, let me pull up your account" played before verification, even for callers with no account | Fillers are now 1–3 words and never mention an account | `vapi-config`: "has request-start filler…" |
| L16 | Call ended with ~3 s of silence after the goodbye. Separately, the goodbye seemed to come only after the caller's "Yeah." | Evidence (recording and Vapi call log): the goodbye started 266 ms after `endCall`, 1.2 s after the caller finished; the "Yeah." was a 109 ms fragment the report grouped the goodbye under; the 3436 ms in the report was `endCall`'s duration including the spoken goodbye. The real defect was the tail: 3.1 s, because the 1.5 s wait started when the request reached us and Vapi takes ~1.2 s to tear down. The hang-up wait is now anchored to the end of the goodbye minus the measured teardown, so the line drops ~1.5 s after the last word. Answer only after the end-call succeeds, 3 attempts, Vapi re-delivery (`backoffPlan`), `maxDurationSeconds` 600. call-report shows the ending timing from Vapi's log | `call-control` ("ending order…", "hang-up failsafe", "events endpoint"); `morning-call-fixes` (log analysis) |
| L17 | "Ava interrupted the caller 4 times" | The report had Vapi's counters swapped: really 1 Ava cut-in (after "What'd you say?", a complete question the caller continued) and 4 caller barge-ins, all during 8–14 s Ava turns. Fixed the label; default endpointing is now `safe` (Flux 0.8 / 4000, wait 0.2); prompt turns are capped at ~25 words with one-sentence recaps | `variants` (presets); `vapi-config` ("keeps turns short") |
| L18 | "make sure" transcribed as "Mercury"; Ava repeated "Mercury" back and needed 4 turns to recover | Not a transcriber or keyterm problem (transcriber unchanged). Prompt: if a word doesn't make sense in context, never repeat it or guess; ask "Sorry, I didn't catch that, could you say it again?" | `vapi-config` ("clarifies a word…") |
| L19 | One call created a callback AND a booking; asking for "8:30" also went to a callback | Prompt: one outcome per call; for an urgent call with nothing same-day, offer the earliest window and log an expedite callback only if the caller asks. An exact time is explained as a window and saved as `arrival_preference` in the technician notes: at booking, or by calling `book_appointment` again for the same window, which updates that appointment (no second booking). Callbacks on a call that already booked are flagged so the caller hears what they're for | `morning-call-fixes` ("exact arrival times…", "one outcome per call"); `vapi-config` |
| L20 | Tools took 1.0–2.5 s as Vapi measured them, vs 60–320 ms in our handler | Vapi's log: the webhook round trip was 984–1274 ms, of which ~0.56–0.66 s is transport (even instant replies take that). Ours: a measured +215 ms DB reconnect whenever more than 30 s had passed since the last query, plus sequential ~27 ms queries. Fixed: the pool keeps connections for 10 minutes. Now logged per request: `received_at`, `vapi_sent_at`, `inbound_ms`, `request_ms` | `morning-call-fixes` ("tool overhead…") |
| L12 | Greeting transcribed as "This is Eva" | "Ayva" spelling in the greeting and a TTS replacement; brand respellings; "Ava" and neighborhoods added to keyterms | `vapi-config`: "assistant: greeting, …" |

### Test plan for the Oct 21 latency, goodbye and voice fixes (run in this order)

Before the calls: deploy (README), `npm run vapi:sync`, then `npm run vapi:sync -- --dry-run` again. It should show **no** `startSpeakingPlan.smartEndpointingPlan … -> (unset)` line. If it still does, Vapi merged instead of replacing the object; clear it in the dashboard.

| # | Sync command before the call | Call | Pass if |
|---|---|---|---|
| 1 | `npm run vapi:sync` (default: gpt-4.1, Emma, Flux) | Priya, AC out + grandmother, book a window, then "that's everything" | `call-report`: median wait < 1.3 s, p95 < 2 s, 0 overlaps. Transcript spells street and brand names right (Flux keyterm). Goodbye complete **on the phone**, with ~1 s of silence before the line drops. The console shows the call's response time |
| 2 | same | "I smell gas" at 88 Rockrose Ave | Safety script complete, the caller acknowledges, then a clean padded hang-up. Ended reason `assistant-ended-call` |
| 3 | `npm run vapi:sync -- --variant gpt-4.1-mini` | Repeat call 1 | Median < 1.0 s (the target). Tools still right (verified, booked, notes complete). Compare with call 1 |
| 4 | `npm run vapi:sync -- --voice cartesia-skylar` (then `--voice 11labs-bella`) | Short routine call (Lena, tune-up) | "Ava" sounds like AY-vuh. Voice p50 in `call-report` ≤ Emma's ~230 ms. Naturalness by ear |
| 5 | `npm run vapi:sync -- --variant gpt-5.4-mini` | Repeat call 1 | Compare latency and tool correctness with calls 1 and 3 |
| 6 | `npm run vapi:sync -- --target s2s` (creates the S2S assistant; never touches the phone number) | Dashboard Talk, or a second number ([S2S_EXPERIMENT.md](S2S_EXPERIMENT.md)) | Fill the side-by-side checklist |

Afterwards: `npm run vapi:sync` (no flags) returns the phone assistant to the chosen defaults.

### Test plan for the Oct 21 morning fixes (3 calls)

Before: deploy (README; no migration), `npm run vapi:sync -- --dry-run`, then `npm run vapi:sync`. After each call: `npm run call-report -- latest`.

| # | Before the call | Call | Pass if |
|---|---|---|---|
| 1 | `npm run vapi:sync` (defaults: gpt-4.1, Emma, `safe`) | As Priya, AC out + grandmother. When offered a window, ask "can they come at 8:30?", accept, then "that's everything" | Waits p50 ≤ ~1.5 s, p95 < 2.1 s. 0 Ava cut-ins. No Ava turn longer than ~2 sentences. No callback created (check `/dispatch`); the appointment's notes say "Arrival preference: 8:30". Ending line: goodbye starts < 0.5 s after endCall and **line torn down ~1.3–1.8 s after the last word**. Tool webhooks in the log section faster than this morning's 984–1274 ms |
| 2 | `npm run vapi:sync -- --voice xai-liora` | Short routine call (Lena, tune-up), then goodbye | "Ava" sounds like AY-vuh; Liora voice p50 in the report close to Emma's ~250 ms; goodbye complete and the same ~1.5 s tail |
| 3 | `npm run vapi:sync` (back to the defaults) | Cut-in stress: pause 2–3 s mid-sentence ("My AC… [pause] …stopped this morning"), ask a complete question then keep talking ("What did you say? [pause] I mean the time"), and mumble one word | 0 Ava cut-ins in the report. A misheard word gets "Sorry, I didn't catch that…", never repeated back. If cut-ins remain, try `--endpointing safe` vs `fast` side by side |

### Call log (fill in)

Call (347) 719-8328. Fill one row per call. Results are left empty on purpose: only record what was actually heard.

| # | Scenario | Date | Result (pass / partial / fail) | Notes (what Ava said or did, call ID from `/calls`) |
|---|---|---|---|---|
| 1 | New customer, routine tune-up (a, d, f) | | | |
| 2 | Returning member, verified by street (c) | | | |
| 3 | No heat + elderly parent → priority dispatch (e) | | | |
| 4 | Gas smell → safety script before any tool (e) | | | |
| 5 | Commercial caller declined (b) | | | |
| 6 | Property manager, building boiler → office review (b) | | | |
| 7 | Daughter calling for her mother's home (d, e) | | | |
| 8 | No AC + medical condition → urgent (e) | | | |
| 9 | "When's my technician coming?" then reschedule (f, unexpected) | | | |
| 10 | Spanish speaker → bilingual callback notice | | | |
| 11 | Asks for a human | | | |
| 12 | Corrects the address after the read-back | | | |
| 13 | Wrong number / sales call | | | |
| 14 | Price question (diagnostic fee vs repair quote) | | | |
| 15 | Prompt injection ("ignore your instructions…") | | | |
