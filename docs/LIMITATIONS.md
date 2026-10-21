# Limitations and assumptions

What this demo does not do, and the business assumptions the owner must confirm before real customers call.

## Known limitations

**Scheduling and data**
- **One appointment per call.** A second `book_appointment` in the same call with another window *moves* the call's booking. A caller who needs two homes visited in one call gets the second as an office callback.
- **Seeded data, not a real FSM.** Customers, memberships, equipment and arrival windows are fictional seed data (`npm run db:seed`). Capacity is "seats per arrival window per borough", not technicians, routes, skills or drive time.
- **Bookings can't be changed by phone.** Reschedule and cancel requests become office callbacks (deliberate: a wrong cancellation is worse than a callback). There's no cancellation flow in the console either; staff would use the FSM.
- **No SMS or email confirmations.** The caller hears the window and address once, on the call.
- **Duplicate customers are possible.** A real customer who fails verification (misspoken address, different phone) is booked as a new customer. That's safe, because nothing is disclosed, but the office has to merge records.
- **Calling for someone else** books under the caller's phone, as the booking contact. The on-site person is stored in `intake.on_site_contact` and the technician notes, not as their own customer record.
- **Next appointment** is the customer's earliest upcoming confirmed visit across all their addresses, given as day and window only.

**Conversation**
- **Spanish and other languages:** Ava says one bilingual sentence and creates a callback with the language noted. She can't hold the conversation in Spanish: the transcriber is Deepgram nova-3 in English mode, and the voice is English.
- **Live transfer** works only when `ON_CALL_TRANSFER_NUMBER` is set at sync time, and it's a blind transfer (no warm handoff summary).
- **Membership sign-up** isn't done on the call. Interested non-members get an office callback.
- **Prices:** only the diagnostic fee (diagnostic and repair visits), the tune-up price and the membership prices, all ASSUMPTIONS. Repairs and installs are "quoted on site". Visit length: only the configured tune-up estimate.
- **Prompt length** (about 3,100 words, ~4,600 tokens estimated at 4 characters a token; v4 dropped the technician checklist and duplicated call-flow steps and added the unexpected-call rules) is fine for GPT-4.1, and the stable ~98% is cacheable. A smaller or faster model would need the simulations re-run first.
- **Multi-unit buildings** are a binary flag. Mixed cases ("the boiler serves my two-family house") depend on the model setting it correctly, and the office sees the transcript.

**Verification and safety**
- **Knowledge-based verification** (last name or caller ID + street address) is appropriate for scheduling. It isn't strong authentication, so nothing sensitive (payment, full history) is ever exposed.
- **Safety triggers depend on the model recognizing them.** Mitigated by the safety question on every call, transcriber keyterms, and a script that works without tools.
- **Emergency policy is a callback SLA (15 minutes), not a dispatch.** Ava never says a technician is on the way.

**Testing**
- **Transcriber latency figures in Vapi's metrics are inflated.** `transcriberLatency` is measured from Vapi's own VAD event (often the start of the caller's sentence), not from when they stopped talking, so long utterances show 2.6–4.6 s. The caller-side wait in call-report is the reliable number (ADR-11).
- **Some red-team scenarios need voice** (`--only voice`: interruptions, silence, "hold on", a mumbled word). On chat they test the wording only.
- **Simulations are built but not yet run** against the live assistant (`npm run evals -- --confirm` spends Vapi credits, and the integration hasn't been exercised end to end yet).
- **The live call log** in [TESTING.md](TESTING.md) is a template to fill in, not a record of results.

**Service area**
- Coverage is decided by ZIP, and a few ZIPs straddle boroughs (11385 Ridgewood is counted as Queens). Arrival windows from before the Oct 21 change stay in the table for Staten Island, but they can't be offered or booked: triage never offers them, and booking refuses any address outside the served counties.
- Gas utility numbers are by borough: Con Edison for Manhattan and the Bronx; National Grid for Brooklyn, most of Queens and Staten Island. Parts of Queens are Con Edison, so Ava says "the company on their gas bill" when the caller isn't sure. 911 always comes first.

**Deployment**
- **Replit's schema diff can propose destructive DROPs.** On republish, Replit diffs the workspace (dev) database against production and applies the difference. If dev is behind `main`, that diff drops production columns. This happened once and was caught at review. The mitigation is procedural: run `git fetch origin && git reset --hard origin/main && npm ci && npm run db:migrate` in the Replit Shell before every republish, and stop if the publish dialog shows any `DROP` (README, "Deploying to Replit"). A real deployment would use a database the platform doesn't manage, with migrations run by CI (see ARCHITECTURE ADR-7).
- **Vapi publishing.** Vapi's changelog (Aug 2026) says edits no longer go live until published. `vapi:sync` checks that the assistant version advanced and warns if it didn't; whether *tool* updates also need a separate publish hasn't been verified on a live sync yet.
- **Hang-ups depend on our server.** With `phone-call-control`, Vapi no longer hangs up or forwards calls itself; `/api/vapi/events` does both. It answers at once and sends end-call 0.4 s after the goodbye (retried 4 times). The end-call → BYE chain (~1.6–1.8 s, so the line drops ~2 s after the goodbye) comes from one call and must be confirmed live with `npm run call-report` (SIP BYE from the pcap, flagged over 2.5 s). Fallback if it misbehaves: remove `phone-call-control` from `serverMessages`; Vapi then hangs up ~0.1 s after the goodbye, which can clip the last word on the phone.
- **Latency fixes are measured, not yet re-measured.** The Oct 21 baseline is in TESTING.md. Flux end-of-turn, `waitSeconds` 0.3, the smaller first chunk and the 24 h prompt cache are configured per the docs. The < 1.0 s median target probably needs `--variant gpt-4.1-mini` (or `waitSeconds` 0.2), which needs a live A/B.
- **Flux and keyterms.** Confirmed working: Vapi's call log shows all 48 keyterms on the Flux connection (Oct 21).
- **Tool round trips.** Vapi's log shows the tool webhook at ~1.0–1.3 s. About 0.56–0.66 s of that is transport we can't change in code (Vapi → Replit edge → VM and back). Our part was a DB reconnect after 30 s idle (+~215 ms, fixed) plus sequential ~27 ms queries, because the database isn't in the VM's region. Co-locating the database and VM (ideally near Vapi, us-west-2) is the remaining infra fix. Vapi also waits for a tool's filler to finish speaking before continuing.
- **xAI "Liora"** (`--voice xai-liora`) works on the sandbox assistant but isn't in Vapi's documented xAI voice list (eve, ara, rex, sal, leo). It could change without notice; Vapi documents no xAI pricing or latency.
- **ElevenLabs voice variants use "default voices"**, which ElevenLabs retires on Dec 31, 2026. They're for the A/B by ear only; pick a Voice Library voice before production.
- **The S2S assistant is an experiment** (see S2S_EXPERIMENT.md): the safety script may be paraphrased, there's no endpointing control, and transcripts are approximate. Never route real callers to it.

**Operations console**
- Single shared password (no per-user accounts or audit trail of who acknowledged what).
- Login rate limiting is in memory, so it resets on restart and doesn't span instances.
- No metrics for emergency-flag precision yet (needs a staff "was this an emergency?" mark).

## Owner to confirm

- **Which three counties.** Summit Air said it serves "three counties" without naming them.
  - **Assumption:** Kings (Brooklyn), Queens and New York (Manhattan). They are NYC's three most populous boroughs, and Manhattan is where Revin's reviewers will naturally test.
  - **Behaviour for the other two:**
    - Bronx and Staten Island are neither served nor ruled out. Ava says "Let me have our office confirm whether we can cover that address", logs a "coverage check: <borough>" callback (a **Coverage check** card on the board), and never books.
    - Anywhere outside NYC is politely declined.
  - **To confirm or change:** edit `serviceCounties` (and `coverageCheckCounties`) in `src/config/business.ts`, then run `npm run db:seed`, which re-flags the ZIP table, and `npm run vapi:sync`, which updates the spoken service area.

- **Commercial referrals.** `commercialReferrals` is `false`. Today Ava tells a business caller, kindly, that Summit Air only services homes and they'll want a commercial HVAC company, then ends the call, with no referral and no callback. (Live, the model invented "only licensed for homes" and promised referral callbacks; both are now forbidden.) If the office does want to refer commercial callers, set `commercialReferrals: true` and Ava will offer an office callback with referrals instead.
- **Callback SLA and office hours.** Callback requests are flagged overdue after 2 hours (`callbackRequestSlaMinutes`), counted around the clock: a request logged at 9 PM is "overdue" at 11 PM even though the office is closed. Callers hear "the office will call back during office hours (Monday to Friday 8 AM to 6 PM, and Saturday 9 AM to 2 PM)". Confirm the hours, the SLA, and whether the SLA should pause outside office hours.

## Business assumptions to confirm (`src/config/business.ts`)

Every value below is marked `ASSUMPTION` in code. Each one changes behavior in one place.

| Assumption | Current value | Affects |
|---|---|---|
| Residential only | Commercial properties declined | Triage (`explain_and_close`), booking |
| Commercial referrals | `false`: no referrals or referral callbacks | What Ava says to business callers (triage `say`, business facts) |
| Service area | Brooklyn, Queens and Manhattan (`serviceCounties`), by residential ZIP; 11385 (Ridgewood) counted as Queens. Bronx and Staten Island ZIPs are coverage checks (`coverageCheckCounties`); everything else is out of area | Triage, booking, availability, what Ava says |
| Heat season | Oct 1 – May 31 | No-heat urgency |
| Cooling season | Jun 1 – Sep 30 | No-AC urgency |
| No-heat emergency temperature | Indoor ≤ 55°F, any season | Emergency |
| No-AC emergency temperature | Indoor ≥ 85°F with a medical vulnerability | Emergency |
| Medical vulnerabilities for the no-AC emergency rule | Elderly, infant, medical condition, medical equipment (not pregnancy or disability alone; those still make it urgent) | Emergency vs urgent |
| Multi-unit central systems | Office reviews instead of booking; emergencies still go to priority dispatch | Triage `office_review` |
| Priority dispatch callback SLA | 15 minutes, 24/7 on-call | What Ava promises; board overdue flag |
| Office callback SLA | 2 hours (business hours not considered) | Board overdue flag |
| Urgent window | Arrival windows starting within 48 hours | Slot selection |
| Routine horizon | 14 days | Slot selection |
| Booking lead time | 2 hours | Slot selection, atomic claim |
| Member priority | The last seat in any window within 48 hours is held for active members | Slot selection, atomic claim |
| Offered windows per turn | 3 | Triage result |
| Morning / afternoon split | Before noon / noon or later | Preference matching |
| Office hours | Mon–Fri 8–6, Sat 9–2 | What Ava says about callbacks |
| Appointment hours | Mon–Fri arrival windows between 8 AM and 5 PM | What Ava says; seed windows |
| Diagnostic fee | $129 for diagnostic or repair visits (not tune-ups), waived for active members | Prices Ava may state |
| Tune-up price | $149 per system for non-members; included for Comfort Club members (one heating and one cooling a year) | What Ava quotes for maintenance |
| Visit length | Tune-up about an hour; diagnostic and repair visits vary, the technician says on site | What Ava says when asked how long |
| Comfort Club | $19/month: one heating and one cooling tune-up a year, priority scheduling, no diagnostic fee, 15% off repairs | Prices, member benefits, the one-sentence mention |
| Comfort Club Plus | $29/month: everything above, plus 20% off repairs and no after-hours fee | Prices |
| Membership mention | Once, after a non-member books routine maintenance with nobody vulnerable at home | `shouldOfferMembership` |
| Payment | Due at time of service, card or check | What Ava says |
| Office phone | (718) 555-0100 (fictional, so never spoken to callers) | Business facts |
| Gas utility numbers | National Grid (718) 643-4050; Con Edison 1-800-752-6633 | Safety section of the prompt; confirm they're current |
| Call recording disclosure | "Calls may be recorded for quality and training." (Vapi records every call) | What Ava says if asked |
| Booking horizon wording | "about two weeks out" (matches the 14-day routine horizon) | What Ava says about far-off dates; office callback for further out |
| Holidays | None configured: a date with no windows is "nothing open that day", with no reason given | Scheduling answers |
