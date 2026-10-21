# Limitations and assumptions

What this demo does not do, and the business assumptions the owner must confirm before real customers call.

## Known limitations

**Scheduling and data**
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
- **Prices:** only the diagnostic fee and the membership prices. Repairs and installs are "quoted on site".
- **Prompt length** (about 3,000 words) is fine for GPT-4.1 but adds a little latency per turn. A smaller or faster model would need the simulations re-run first.
- **Multi-unit buildings** are a binary flag. Mixed cases ("the boiler serves my two-family house") depend on the model setting it correctly, and the office sees the transcript.

**Verification and safety**
- **Knowledge-based verification** (last name or caller ID + street address) is appropriate for scheduling. It isn't strong authentication, so nothing sensitive (payment, full history) is ever exposed.
- **Safety triggers depend on the model recognizing them.** Mitigated by the safety question on every call, transcriber keyterms, and a script that works without tools.
- **Emergency policy is a callback SLA (15 minutes), not a dispatch.** Ava never says a technician is on the way.

**Testing**
- **Simulations are built but not yet run** against the live assistant (`npm run evals -- --confirm` spends Vapi credits, and the integration hasn't been exercised end to end yet).
- **The live call log** in [TESTING.md](TESTING.md) is a template to fill in, not a record of results.

**Operations console**
- Single shared password (no per-user accounts or audit trail of who acknowledged what).
- Login rate limiting is in memory, so it resets on restart and doesn't span instances.
- No metrics for emergency-flag precision yet (needs a staff "was this an emergency?" mark).

## Business assumptions to confirm (`src/config/business.ts`)

Every value below is marked `ASSUMPTION` in code. Each one changes behavior in one place.

| Assumption | Current value | Affects |
|---|---|---|
| Residential only | Commercial properties declined | Triage (`explain_and_close`), booking |
| Service area | Brooklyn, Queens, Staten Island, by residential ZIP; 11385 (Ridgewood) counted as Queens | Triage, booking, availability |
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
| Diagnostic fee | $129, waived for active members | Prices Ava may state |
| Comfort Club | $19/month: one heating and one cooling tune-up a year, priority scheduling, no diagnostic fee, 15% off repairs | Prices, member benefits, the one-sentence mention |
| Comfort Club Plus | $29/month: everything above, plus 20% off repairs and no after-hours fee | Prices |
| Membership mention | Once, after a non-member books routine maintenance with nobody vulnerable at home | `shouldOfferMembership` |
| Payment | Due at time of service, card or check | What Ava says |
| Office phone | (718) 555-0100 (fictional, so never spoken to callers) | Business facts |
| Gas utility numbers | National Grid (718) 643-4050; Con Edison 1-800-752-6633 | Safety section of the prompt; confirm they're current |
