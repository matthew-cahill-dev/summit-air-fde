# Rollout plan

The goal is to earn trust one step at a time. Each phase has an exit bar measured on real calls, and every phase can be rolled back by changing where the phone number forwards.

## Phases

| Phase | What happens | Exit criteria (all must hold for 2 weeks) |
|---|---|---|
| **0. Shadow** | Humans keep answering every call. Ava runs on a copy of the line (or on recordings and transcripts replayed through the simulations), and nothing she does reaches customers. Staff review her triage reasons, technician notes and bookings next to what the human actually did | Triage agrees with the human on every safety stop and emergency; no disclosure before verification; technician notes rated "usable as-is" on ≥ 90% of samples |
| **1. After-hours only** | Ava answers when the office is closed, when today a call goes to voicemail. Emergencies become priority dispatches to the on-call team (15-minute callback policy); everything else is booked or becomes a morning callback | Emergency-flag recall 100%; precision ≥ 80% (false alarms are acceptable, missed emergencies are not); booking conversion ≥ the voicemail baseline; no complaints about safety handling |
| **2. Overflow during surges** | During heat waves and cold snaps, calls the office can't pick up within ~30 seconds roll to Ava instead of hold or voicemail | Answer rate ≥ 98% on surge days; abandoned calls down vs the same weather last year; human transfer and callback rate stable or falling |
| **3. Primary** | Ava answers first; staff handle callbacks, transfers and the board | CSAT on agent-handled calls within a few points of human-handled calls; average handle time at or below human; office staff time shifted from phones to callbacks and dispatch |

Rollback at any phase: point the number back at the office line in the telephony settings (minutes). The backend keeps every record, so nothing is lost.

## Success metrics

| Metric | Definition | Source today |
|---|---|---|
| Answer rate | Calls answered by a human or Ava ÷ calls received | Telephony / Vapi call logs |
| Booking conversion | Calls ending in a confirmed appointment ÷ calls with a serviceable, bookable issue | `appointments` joined to `calls`; the console's call outcome |
| Emergency-flag precision | Priority dispatches the on-call team agrees were emergencies ÷ all priority dispatches | `dispatch_requests` + a staff "was this an emergency?" mark (to add on the board) |
| Emergency-flag recall | Emergencies Ava flagged ÷ all real emergencies, including any found later in transcripts or callbacks | Weekly transcript review in shadow and after-hours phases |
| Transfer and callback rate | Calls ending in a transfer or a callback request ÷ all calls, split by reason (human requested, backend failure, language, office review) | `callback_requests.reason`, Vapi transfer events |
| Average handle time | Mean call duration by outcome | `calls.started_at` / `ended_at` |
| Tool reliability | Tool error rate and p95 latency | `tool_invocations` (already on `/overview`) |
| CSAT | Post-call SMS one-question survey (1–5) | To add with SMS |

## Integrations to add

1. **Field service management: ServiceTitan or Housecall Pro.** Real customers, memberships, equipment history and technician schedules instead of seeded tables. The repository interfaces (`src/server/repositories/types.ts`) are the seam: implement `CustomerRepository` and `SchedulingRepository` against the FSM API, and keep the atomic-claim guarantee by booking through the FSM's own job and appointment endpoints. Cache read-mostly data (memberships, equipment), because Vapi's tool timeout is 10 seconds.
2. **SMS confirmations** (Twilio or the FSM's built-in texting): booking confirmation with the window and address, a reminder the day before, "reply to reschedule", and the CSAT survey.
3. **Multilingual.** Today a Spanish speaker gets a bilingual notice and a callback. Next: Deepgram's multilingual mode (`language: multi`) or a Spanish transcriber, a Spanish-capable voice, and a Spanish prompt variant switched by detected language. Re-run the full simulation suite in each language.
4. **Live transfer** to the on-call team for emergencies and human requests (already supported: set `ON_CALL_TRANSFER_NUMBER` and re-sync).
5. **Structured outputs** in place of the deprecated `analysisPlan` summary, for per-call outcome fields the board can filter on.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Vapi concurrency during surges.** The plan's concurrent-call limit is hit on the coldest morning of the year | Callers get busy signals exactly when demand peaks | Check and raise the org concurrency limit before winter; telephony overflow to the office line or voicemail when Ava is at capacity; load-test with simulations (`--voice`) at the expected peak |
| **Telephony outage** (carrier or Vapi) | No calls answered | Carrier-level failover forwarding to the office line; Vapi status alerts; the business number stays owned by Summit Air, not by Vapi |
| **Backend down mid-call** | Tools fail | Safety script works with zero tools; tool failure → apologize once, callback; if the callback fails, say nothing was logged and to call back. Reserved VM with health check `/api/health`; uptime alert |
| **PII retention.** Transcripts, recordings, addresses and phone numbers | Privacy exposure, NY SHIELD Act obligations | Set Vapi recording and transcript retention to the minimum the business needs; purge `calls.transcript` and `raw_report` after N days (a scheduled job); console behind a password today, SSO later; never log tool argument values (already enforced: envelopes log key names only) |
| **Recording disclosure.** NY is one-party consent, but callers may be in all-party states, and it's good practice | Legal and trust risk | Add "this call may be recorded" to the greeting before enabling recording, or keep recording off and rely on transcripts with the same disclosure |
| **Model regression** after a provider update | Rules silently stop being followed | Pin a dated model snapshot; run `npm run evals -- --confirm` before every prompt or model change and weekly; the backend-enforced rules (triage, verification, capacity) don't depend on the model |
| **Over-flagging emergencies** | On-call fatigue | Track precision; tune thresholds in `business.ts` with the owner, never in the prompt |
