# Changelog

## v1-submission (2026-10-21)

Ava, Summit Air's AI phone agent, and the operations console, as submitted.

**Calls**
- Answers (347) 719-8328 around the clock on Vapi (Deepgram Flux, GPT-4.1, Vapi voice).
- Recognizes returning customers by last name and street, and discloses nothing before verification.
- Triages deterministically in code and books real arrival windows with atomic seat claims and technician notes.
- Logs priority requests for the on-call team with a 15-minute callback SLA, and takes office callbacks for everything else.
- Handles the unexpected: businesses, out-of-area and coverage-check addresses, other languages, requests for a person, prompt injection, wrong numbers, child callers.

**Safety in depth**
- The safety script and "call 911" come first and never depend on a tool.
- A caller-words matcher escalates triage when the model's flags miss a sign.
- Emergencies fail open, and triage writes the dispatch record itself.
- The booking guard and the child-caller guard refuse on the server.
- A hang-up safety net and post-call transcript reconciliation are the final backstops.

**Operations console**
- **Dispatch board:** New → Called back → Resolved with an outcome, with operator stamps and undo.
- **Appointments:** complete, no-show, cancel, and reschedule from live availability.
- **Calls:** call detail with the transcript, each action Ava took, and the follow-up trail.
- **Overview:** "Needs attention now", one metrics module so every number agrees, and test runs and seed data hidden by default.

**Engineering**
- Vapi config as code, synced and published with `npm run vapi:sync`, with A/B variants for model, voice, endpointing and the call ending.
- 627 automated tests against a real Postgres.
- 46 scenario evals with code-checked tool criteria and multi-iteration reliability runs.
- `npm run call-report` for caller-side latency and the real hang-up.
- Latency of p50 ~1.46 s / p95 ~2.05 s, caller stops → Ava starts.

## After submission

- Docs consistency pass (no behavior changes).
- Client session 1 fixes (live call `01a165a4`): an "anyone feeling unwell?" check when a caller might be unwell; the gas/CO question on heating calls only; one technician question instead of five; priority requests logged by triage, with the callback number confirmed instead of asked; emergencies skip the lookup gate; names spelled back, said back after booking, and correctable on the same call. 640 tests, 49 scenarios.
