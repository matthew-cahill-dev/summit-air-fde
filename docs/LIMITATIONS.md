# Limitations and assumptions

What Ava and the operations console don't do yet, and the business assumptions Summit Air should confirm before real customers call.

## Known limitations

**Safety: what code guarantees, and what still depends on the model**
- **Code guarantees the record and the refusals; the model owns the speech.**
  - **Code:** every emergency or safety call ends with a record on the dispatch board, and emergency and child-caller bookings are refused ([ADR-9](ARCHITECTURE.md#adr-9-safety-in-depth-emergencies-fail-open)).
  - **Model:** the exact wording and order of what Ava says. Examples: "Please call nine one one now" before the gas/CO question, the safety script word for word, not ending the call early. These are prompt rules, measured by the evals.
- **The safety matcher is English-only, conservative and escalate-only.**
  - It reads fixed phrases in the caller's own words, with negation handling ("no gas smell", "carbon monoxide, no.").
  - Unusual wording can slip past it; the model's own flags and the hang-up check on triage results still apply.
  - It can rarely over-trigger ("dizzy" said about something else). That means an extra record on the board, never a missed one.
- **Post-call reconciliation runs on phone calls only.** Chat simulations send no end-of-call report, so in a chat eval a conversation that never calls `triage_issue` has no backstop. On the phone, the hang-up safety net and reconciliation both cover it.
- **The child-caller guard is deliberately conservative.**
  - It fires on a stated age of 15 or under, a school grade, "I'm a kid" or "I don't know my last name". A sleeping or at-work parent counts only with a second sign.
  - A child who gives a full name and mentions none of these isn't recognized.
- **Emergency policy is a callback SLA (15 minutes), not a dispatch.** Ava never says a technician is on the way.

**Calls and telephony**
- **Vapi's teardown sets a ~3.5 s floor** between the goodbye and the line dropping with our controlled ending. Vapi's own hang-up is faster (~0.1 s) but clips the goodbye on some carriers ([ADR-10](ARCHITECTURE.md#adr-10-call-endings-the-goodbye-in-full-then-a-hang-up-we-control)).
- **Our hang-up request can get HTTP 400** when Vapi has already begun ending the call (seen on call `01a15feb`). The call still ends normally; the attempt is logged.
- **Neon suspends idle connections.** The pool logs `db_pool_idle_error` and reconnects automatically. The ping at call start (`status-update`) wakes the database during the greeting, so the first tool call doesn't pay for it.
- **Tool round trips** are ~0.7–1.3 s as Vapi measures them. About 0.6 s of that is transport we can't change in code; co-locating the database and the VM is the remaining infra step.
- **Vapi's transcriber latency metric is inflated** (anchored at its own VAD event). The caller-side wait in `call-report` is the reliable number.
- **Spanish and other languages:** Ava says one bilingual sentence and creates a callback with the language noted. The transcriber and voice are English.
- **Live transfer** works only when `ON_CALL_TRANSFER_NUMBER` is set, and it's a blind transfer.

**Data and integrations**
- **No field-service integration (ServiceTitan).** Customers, memberships, equipment and arrival windows are fictional seed data, and the console stands in for the FSM. Capacity is "seats per arrival window per borough", not technicians, routes, skills or drive time.
- **Changes by phone become callbacks.** Reschedule and cancel requests are taken as office callbacks (a wrong cancellation is worse than a callback). Staff complete them in the console.
- **One appointment per call.** A second home in the same call becomes an office callback.
- **No SMS or email confirmations.** The caller hears the window and address once, on the call.
- **Duplicate customers are possible** when a real customer fails verification. That's safe (nothing is disclosed), but the office merges records.
- **Calling for someone else** books under the caller's phone. The on-site person is in the technician notes, not their own customer record.

**Operations console**
- **One shared login.** There are no per-user accounts. Actions are stamped with an operator name typed in the header (stored in the browser), not an authenticated identity.
- **Login rate limiting is in memory,** so it resets on restart.
- **Deferred items:**
  - Simulation detection is inferred from the message shape (a chat, no call, or a non-phone call type). A call with no type counts as real, so a real caller is never hidden.
  - The Calls page loads the latest 300 calls.
  - Undoing a reschedule into a window where the customer had an older cancelled booking removes that old row.
  - A booking made and then cancelled the same day drops out of the "Bookings" count.
  - The activity feed doesn't show appointment changes yet; they're on the call's follow-up trail.
  - Dispatch cards are clickable and contain buttons (nested interactive elements).
  - No emergency-flag precision metric yet (needs a staff "was this an emergency?" mark).

**Deployment**
- **Replit's schema diff can propose destructive DROPs** if the workspace database is behind `main`. The procedure in the README ("Deploy") prevents it, and any `DROP` in the publish dialog means stop ([ADR-7](ARCHITECTURE.md#adr-7-idempotent-migrations-and-the-replit-schema-diff)).
- **Vapi publishing.** `vapi:sync` checks that the assistant version advanced and warns if it didn't. Whether tool-only updates need a separate publish hasn't been confirmed.
- **Voice variants:**
  - xAI "Liora" isn't in Vapi's documented voice list.
  - The ElevenLabs variants use "default voices" that ElevenLabs retires on Dec 31, 2026.
  - Both are for A/B tests only.
- **The speech-to-speech assistant is an experiment** ([S2S_EXPERIMENT.md](S2S_EXPERIMENT.md)); it never takes real calls.

## Next with more time

1. **A/B voice stacks on the same evals.** For example, Vapi vs. LiveKit Agents vs. OpenAI Realtime against the same tools API, judged by the scenario suite and `call-report` latency.
2. **A Spanish flow:** a multilingual transcriber, a Spanish voice and a prompt variant, re-running the evals in Spanish.
3. **Field-service integration** (ServiceTitan) behind the existing repository interfaces.
4. **Staff authentication and roles** for the console, with per-user audit.
5. **SMS or pager alerting** for safety stops and emergencies, alongside the board.
6. **A live transcript watcher.** Subscribe to Vapi's real-time transcript events and run the safety matcher on each caller turn, creating the safety record mid-call. The office would be alerted during the call without depending on any tool call (closing the "script spoken, triage skipped" gap seen in run `dde50f9c`).

## Owner to confirm

- **Which three counties.** The brief says Summit Air serves "three counties" without naming them.
  - **Assumption:** Kings (Brooklyn), Queens and New York (Manhattan).
  - **Bronx and Staten Island** get an office coverage check (a "Coverage check" card on the board) and are never booked. Anywhere outside NYC is declined kindly.
  - **To change it:** edit `serviceCounties` and `coverageCheckCounties` in `src/config/business.ts`, then run `npm run db:seed` (re-flags the ZIPs) and `npm run vapi:sync` (updates the spoken service area).
- **Commercial referrals.** Today a business caller hears, kindly, that Summit Air only services homes. There's no referral and no callback (`commercialReferrals: false`). Set it to `true` to offer an office callback with referrals.
- **Callback SLA and office hours.** Office callbacks are flagged overdue after 2 hours, counted around the clock. Confirm the hours, the SLA, and whether it should pause outside office hours.

## Business assumptions to confirm (`src/config/business.ts`)

Every value below is marked `ASSUMPTION` in code. Each one changes behavior in one place.

| Assumption | Current value | Affects |
|---|---|---|
| Residential only | Commercial properties declined | Triage (`explain_and_close`), booking |
| Commercial referrals | `false`: no referrals or referral callbacks | What Ava says to business callers |
| Service area | Brooklyn, Queens and Manhattan (`serviceCounties`), by residential ZIP; 11385 (Ridgewood) counted as Queens. Bronx and Staten Island ZIPs are coverage checks; everything else is out of area | Triage, booking, availability, what Ava says |
| Heat season | Oct 1 – May 31 | No-heat urgency |
| Cooling season | Jun 1 – Sep 30 | No-AC urgency |
| No-heat emergency temperature | Indoor ≤ 55°F, any season | Emergency |
| No-AC emergency temperature | Indoor ≥ 85°F with a medical vulnerability | Emergency |
| Medical vulnerabilities for the no-AC emergency rule | Elderly, infant, medical condition, medical equipment (pregnancy or disability alone make it urgent) | Emergency vs urgent |
| Multi-unit central systems | Office reviews instead of booking; emergencies still go to the on-call team | Triage `office_review` |
| Priority dispatch callback SLA | 15 minutes, 24/7 on-call | What Ava promises; board overdue flag |
| Office callback SLA | 2 hours (business hours not considered) | Board overdue flag |
| Urgent window | Arrival windows starting within 48 hours | Slot selection |
| Routine horizon | 14 days | Slot selection |
| Booking lead time | 2 hours | Slot selection, atomic claim |
| Member priority | The last seat in any window within 48 hours is held for active members | Slot selection, atomic claim |
| Offered windows per turn | 3 | Triage result |
| Office hours | Mon–Fri 8 AM–6 PM, Sat 9 AM–2 PM | What Ava says about callbacks |
| Appointment hours | Mon–Fri arrival windows between 8 AM and 5 PM | What Ava says; seed windows |
| Diagnostic fee | $129 for diagnostic or repair visits (not tune-ups), waived for active members | Prices Ava may state |
| Tune-up price | $149 per system for non-members; included for Comfort Club members | What Ava quotes for maintenance |
| Visit length | Tune-up about an hour; diagnostic and repair visits vary | What Ava says when asked how long |
| Comfort Club | $19/month: two tune-ups a year, priority scheduling, no diagnostic fee, 15% off repairs | Prices, member benefits, the one-sentence mention |
| Comfort Club Plus | $29/month: everything above, plus 20% off repairs and no after-hours fee | Prices |
| Membership mention | Once, after a non-member books routine maintenance with nobody vulnerable at home | `shouldOfferMembership` |
| Payment | Due at time of service, card or check | What Ava says |
| Gas utility numbers | National Grid (718) 643-4050; Con Edison 1-800-752-6633 | Safety section of the prompt; confirm they're current |
| Call recording disclosure | "Calls may be recorded for quality and training." | What Ava says if asked |
| Holidays | None configured: a date with no windows is "nothing open that day" | Scheduling answers |
