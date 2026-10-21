# Architecture

Summit Air's phone agent is split in two. **Vapi** runs the call: telephony, speech-to-text (Deepgram), the language model (GPT-4.1) and text-to-speech. **This Next.js app** owns every business decision and every record: who the caller is, how urgent the problem is, which arrival windows exist, what gets booked, and what the office sees.

The model talks to the caller and decides *what to ask next*. The backend decides *what is true and what is allowed*.

## Call flow

```mermaid
flowchart LR
    caller([Caller<br/>phone]) -->|PSTN| vapi

    subgraph vapi [Vapi]
        direction TB
        stt[Deepgram nova-3<br/>speech to text] --> llm[GPT-4.1<br/>system prompt + 7 tools]
        llm --> tts[Vapi voice<br/>text to speech]
    end

    llm -->|"POST /api/vapi/tools<br/>Bearer secret"| tools
    vapi -->|"POST /api/vapi/events<br/>status-update, end-of-call-report"| events

    subgraph app [Next.js app on a Replit Reserved VM]
        direction TB
        tools[Tools endpoint<br/>auth, idempotency, Zod] --> services[Services<br/>lookup, triage, availability,<br/>booking, dispatch, callback]
        services --> rules[Pure rules<br/>triage, slot selection,<br/>address match, notes]
        services --> repos[Repositories]
        events[Events endpoint<br/>keep-warm, call reports] --> repos
        console[Operations console<br/>dispatch, calls, appointments, overview] --> repos
    end

    repos --> pg[(Postgres)]
    staff([Office staff]) -->|session cookie| console
```

| Layer | Where | Responsibility |
|---|---|---|
| Voice and conversation | Vapi, configured from `vapi/` | Turn-taking, transcription, the model, the voice. The prompt (`vapi/system-prompt.md`) governs tone, order of questions and safety wording |
| Tools endpoint | `src/app/api/vapi/tools/route.ts` → `src/server/vapi/http.ts`, `dispatcher.ts` | Constant-time bearer check, idempotency, Zod validation with field-named errors, always HTTP 200 |
| Services | `src/server/services/` | One per tool. They compose rules and data access, and return `{ ok, data, say }` |
| Pure rules | `src/server/triage/rules.ts`, `src/server/scheduling/`, `src/server/lib/address-match.ts` | No I/O and no clock. The parts that most need to be right, so they're the most heavily tested |
| Repositories | `src/server/repositories/` | The only code that touches Drizzle/SQL |
| Console | `src/app/(console)/`, `src/server/console/` | Staff UI that reads the same tables the agent writes |
| Business assumptions | `src/config/business.ts` | Service ZIPs, seasons, SLAs, prices, membership wording. Each is marked `ASSUMPTION` |

## One booking call

```mermaid
sequenceDiagram
    autonumber
    actor C as Caller
    participant V as Vapi (model)
    participant T as /api/vapi/tools
    participant S as Services
    participant DB as Postgres

    V->>C: "Hi, thanks for calling Summit Air! This is Ava..."
    Note over V,T: status-update (in-progress) → /api/vapi/events runs a non-blocking select 1 to wake the DB
    C->>V: "My furnace needs a tune-up."
    V->>C: Safety screen: gas smell or CO alarm?
    C->>V: "No."
    V->>T: lookup_customer {} (caller ID)
    T->>S: idempotency check, Zod
    S->>DB: customer by phone
    S-->>V: found, verification_required (discloses nothing)
    V->>C: "What's the address where you need service?"
    C->>V: "Four twelve Seventh Avenue."
    V->>T: lookup_customer {street_address}
    S->>DB: address match, next appointment
    S-->>V: verified, first name, member benefits, next_appointment
    V->>T: triage_issue {issue_type: maintenance, flags, zip}
    S->>S: triageRules() → routine, book_standard
    S->>DB: open slots in the county
    S-->>V: up to 3 offered_slots with spoken labels
    V->>C: Offers a window, gathers technician intake one question at a time
    V->>C: Read-back: name, address, window, problem. "Does all of that sound right?"
    C->>V: "Yes."
    V->>T: book_appointment {slot_id, caller_confirmed: true, intake...}
    S->>DB: BEGIN; UPDATE slot SET booked = booked + 1 WHERE booked < capacity − held RETURNING; INSERT appointment + technician_notes; COMMIT
    S-->>V: booked, window, address (+ one-time membership mention for non-members)
    V->>C: Recap, anything else?
    Note over V,DB: end-of-call-report → calls table (summary, transcript) → console
```

## Design decisions

Short ADRs. Each one gives the context, the decision, and what it costs.

### ADR-1: The model decides what to ask; the backend enforces what's true

- **Context.** LLMs are good at conversation and unreliable at rules. They drift, misremember thresholds and say "you're booked" when they aren't. A wrong booking or a missed emergency costs far more than a slightly awkward phrase.
- **Decision.** The model extracts facts (issue type, flags, address as spoken) and chooses wording. The backend decides urgency, availability, identity, capacity and what may be disclosed. Each tool result carries a `say` hint, and the prompt says never to claim an action happened unless that tool returned `ok: true`.
- **Tradeoff.** More tool calls and a stricter tool contract. In return, the outcomes that matter can be tested without a phone. The owner can change a business rule in TypeScript instead of re-tuning a prompt.

### ADR-2: Deterministic triage

- **Context.** "No heat in winter, no AC with a medical condition or elderly resident, gas smell" are business rules with real consequences. They have edge cases: season boundaries, temperature thresholds, pregnancy versus medical conditions.
- **Decision.** `triageRules()` is a pure function of the flags the model extracted, the ZIP's service area and today's date. It returns urgency, human-readable reasons (shown to staff) and the next action. Safety stops override everything. Thresholds live in `business.ts`.
- **Tradeoff.** Triage is only as good as the extracted flags. If the model misses "my dad is 82", the rules can't recover. The prompt therefore asks the vulnerable-occupant question explicitly, and the transcript plus reasons on the console let staff audit it.

### ADR-3: Verify before disclose

- **Context.** Caller ID is spoofable, and a phone agent that reads back "I see you at 412 Seventh Ave, Comfort Club Plus" leaks PII to anyone holding the number.
- **Decision.** `lookup_customer` returns nothing about an account until the *caller* states a street address that matches one on file. Spoken forms are tolerated ("thirty-seven twelve eighty-second street" and the STT form "37 12 80 second Street" both match 37-12 82nd St). Not-found and mismatch look identical. Three failed attempts lock verification for the call. Next appointment, membership and equipment ride on the verified result only.
- **Tradeoff.** A real customer who misspeaks their address is treated as new. That is safe, because booking never requires verification, but it can create a duplicate customer record that the office merges later.

### ADR-4: Idempotency keys on every tool call

- **Context.** Vapi retries on timeouts, and models sometimes repeat a tool call. A repeated `book_appointment` must not take two seats.
- **Decision.** Key = `callId:tool:sha256(canonicalJSON(args))`, unique in `tool_invocations`. A replay returns the stored result byte for byte. Only an `internal_error` is overwritten, so a transient failure can be retried. Bookings are also unique per (customer, slot), and dispatches are de-duplicated per call.
- **Tradeoff.** The same arguments with a deliberately different intent replay instead of re-running. On a phone call that's always the safer reading.

### ADR-5: Atomic seat claims

- **Context.** Two callers can choose the last window at the same moment. Members are promised first pick.
- **Decision.** One conditional `UPDATE … SET booked = booked + 1 WHERE booked < capacity − reserved RETURNING` inside the booking transaction. The member-held seat (the last seat in windows within 48 hours) is part of the same `WHERE`. A losing caller gets `slot_taken` with three alternatives. A test runs two concurrent bookings for one seat.
- **Tradeoff.** Capacity is counted in seats per window, not technician routes or drive time. That's adequate for a demo, and it's the first thing a real FSM integration replaces.

### ADR-6: Vapi config as code, synced with versioned publishes

- **Context.** Hand-edited dashboard config drifts from the backend's tool schemas, and nobody can review or roll it back.
- **Decision.** `vapi/system-prompt.md` (a template filled from `business.ts`), `vapi/tools/*.json` and `vapi/assistant.json` are the source of truth. `npm run vapi:sync -- --dry-run` diffs against live Vapi, and `npm run vapi:sync` upserts tools by name and updates the assistant, which publishes a new Vapi version that the script prints. A test checks every tool's JSON parameters against the server's Zod schema, so the two can't drift.
- **Tradeoff.** Someone editing in the Vapi dashboard gets overwritten on the next sync. That's intentional, but it has to be communicated.

### ADR-7: Idempotent migrations and the Replit schema diff

- **Context.** On republish, Replit diffs the *development* database's schema against production and applies the difference to production before our start command runs. Two consequences:
  - A plain `ALTER TABLE ADD COLUMN` in our migration then fails because Replit already added the column, and the app never boots.
  - Worse, when the dev database is *behind* (a migration ran on production but not in the workspace), the diff tries to make production match the older schema, so it proposes destructive `DROP COLUMN` / `DROP TABLE` statements. This happened once and was caught in the publish review before it ran.
- **Decision.**
  - Every migration after the initial baseline (`0000_init.sql`) uses `IF NOT EXISTS`. Migrations run on every start (`start:deploy`) under a Postgres advisory lock, so our migrator stays the source of truth.
  - Before every republish, the Replit Shell runs `git fetch origin && git reset --hard origin/main && npm ci && npm run db:migrate` (README, "Deploying to Replit"), so dev equals `main` and the platform diff is empty. Any `DROP` in the publish dialog means stop.
  - The live-call tuning (Oct 21) needed no migration: new fields live in existing jsonb columns, and callback de-duplication uses an advisory lock instead of a unique index. An index could fail on production rows that are already duplicated.
- **How a real deployment would do it.** Take schema changes away from the platform entirely: a managed Postgres (Neon, RDS or Supabase) that the host only reaches through `DATABASE_URL`, with no platform-linked database and no auto-diff; migrations applied once, by CI, as a release step (`drizzle-kit migrate` against production with a reviewed SQL diff), never on app start; and a database role for the app that has no DDL rights, so nothing at runtime can drop a column.
- **Tradeoff.** Hand-editing generated SQL after `db:generate`, and a manual pre-publish step that someone can forget. The README makes it the first deploy instruction.

### ADR-8: Always-on hosting

- **Context.** Vapi waits about 10 seconds for a tool result. A scale-to-zero host plus a suspended database can spend most of that on a cold start, while a caller sits in silence.
- **Decision.** Replit Reserved VM (`deploymentTarget = "gce"`). The assistant sends `status-update`, and on `in-progress` the events endpoint fires a non-blocking `select 1`, so the database wakes during the greeting instead of on the first tool call.
- **Tradeoff.** A fixed monthly cost even at zero calls, which is trivial next to one missed emergency.

### ADR-9: A fail-safe safety script that doesn't depend on tools

- **Context.** The highest-stakes moment (a gas smell or CO alarm) is exactly when the backend might be down.
- **Decision.** The leave-now / call-911-from-outside script is in the system prompt and is spoken *before* any tool call. The prompt says it never depends on a tool. `triage_issue` then records a `safety_stop` follow-up as best effort, and its `say` adapts if recording failed ("Do not say the office was notified"). The agent always says Summit Air has not called 911.
- **Tradeoff.** The model is trusted to recognize the trigger. Mitigations: the explicit safety-screen question on every call, Deepgram keyterms for "carbon monoxide", and a live scenario and eval for it (`e-gas-smell`).

### ADR-10: Call endings: the goodbye in full, a short fixed tail, then a hang-up we control

- **Context.**
  - Round 1: the model said its own goodbye, then Vapi's was cut off mid-word.
  - Round 2: the recording had the full goodbye but the phone clipped it. With Vapi's own hang-up, the SIP BYE leaves **~0.1 s** after the goodbye audio stops (pcap of call `01a15cfc`: BYE at +118 ms). The caller's audio runs ~0.5–1 s behind ours, so the carrier dropped the last words. **Recording complete, phone path clipped → tail padding.**
  - Round 3 (Oct 21 morning, `01a15e9b`): we answered Vapi's hang-up request at once, then sent end-call 1.5 s later. The goodbye played in full, but the BYE left **3.57 s** after it (the caller heard ~3.1 s of silence).
  - Round 4 (Oct 21 afternoon, `01a15edf` and `01a15ee6`): an "anchored" version that answered Vapi **only after its end-call succeeded**. Root cause of the regression, from Vapi's call log and SIP capture:
    1. Vapi sends `phone-call-control` ~5 ms after the goodbye stops. Per the API spec, delegation means "Vapi will no longer do the actual transfer and hangup".
    2. Vapi doesn't accept our end-call while it is still waiting for our answer to that request. All 3 attempts per delivery failed fast, so we answered **502**.
    3. Vapi re-delivered twice (backoff 1 s, 2 s; ≈1.9 s per delivery including our 1.1 s of retry sleeps). After **8.6–8.8 s** it gave up and ended the call itself (`endedAt` = the failed webhook + ~10 ms).
    4. Meanwhile the line stayed open (the stream was torn down ~2.6 s later, ~11.3 s after the goodbye), and the idle hook "Take your time. I'm here." fired into it 10 s after the goodbye.
  - The old "line torn down" figure in call-report was Vapi's stream-cleanup log row. That row lags the call's end by ~2.6 s in every mode, so it isn't the line drop. The SIP BYE in Vapi's packet capture is.
- **Decision.**
  1. **One goodbye.** The model never says goodbye; it calls `endCall`, whose blocking `request-start` message is the closing line. `endCallPhrases: ["goodbye for now"]` is the backstop.
  2. **Answer at once, then a fixed short tail** (`src/server/vapi/call-control.ts`). `/api/vapi/events` answers `phone-call-control` with 200 immediately and never with 5xx. The end-call (`{"type":"end-call"}` to `call.monitor.controlUrl`) runs after the answer (Next's `after()`), at the goodbye's end (Vapi's `timestamp`) + `HANGUP_SEND_DELAY_MS` (default **400 ms**).
     - Retries: 250, 500 and 1000 ms apart, in case our answer hasn't landed yet.
     - **Hard guard:** the first end-call is never sent later than 1.0 s after the goodbye, whatever is configured.
     - Expected BYE: about goodbye + 0.4 s + the ~1.6–1.8 s chain from end-call to BYE (from the morning call), i.e. **~2.0–2.2 s**. The caller hears **~1.2–1.8 s** of silence after the last word, because their audio lags ours.
     - The anchored math (`farewellEndAt`, the teardown estimate) is gone: it was the part that couldn't be verified.
  3. **Every ending path is the same.** Goodbye, safety stop, commercial decline, non-service call, abusive caller and end-call phrase all produce the same Vapi hang-up request. A test checks every model × voice × target × endpointing combination delegates it.
- **Measured on every call.**
  - `npm run call-report` reads the SIP BYE from Vapi's pcap (`artifact.presignedPcapUrl`) and prints "Teardown (SIP BYE after the goodbye stopped)". It flags anything over **2.5 s** (exit code 2), a missing BYE, and an idle hook that fired after the goodbye.
  - The server logs `call_control_scheduled` (received_after_goodbye_ms, delay_ms) and `call_control` (attempt, sent_after_goodbye_ms, accepted_after_goodbye_ms) per call.
- **Failsafe.** End-call is retried 4 times. If all fail, the failure is logged. The answer was already 200, so Vapi doesn't re-deliver; re-delivery can't help an end-call that Vapi only accepts after our answer. The caller normally hangs up anyway, and `maxDurationSeconds: 600` caps the call.
- **Open risk and fallback.**
  - The end-call → BYE chain (~1.6–1.8 s) is from one call. If the next live call shows the BYE more than 2.5 s after the goodbye, or end-call being ignored, the fallback is one line: remove `phone-call-control` from `serverMessages`. Vapi then hangs up itself ~0.1 s after the goodbye, which reliably ends the call but clips the last word on some carriers.
  - Vapi has no padding setting for its own hang-up (checked: `/tools/hang-up` docs, the API spec), and the Emma voice has no SSML pauses. A tail inside the audio isn't available.

### ADR-11: Turn-taking and latency, measured

- **Measurements** (`npm run call-report`, waits = caller stops → Ava starts):

  | Config | p50 / p95 |
  |---|---|
  | Oct 20 night, LiveKit "Conservative" | 2030 / 3180 ms |
  | Oct 21 morning, Flux 0.7 / 3000 + wait 0.3 | **1504 / 2065 ms** |
  | Oct 21 afternoon, `safe` (0.8 / 4000 + wait 0.2), call `01a15edf` | 1501 / 2941 ms, worst turn 5.5 s (Vapi) |
  | Oct 21 afternoon, `fast` (0.7 / 3000 + wait 0.2), call `01a15ee6` | **1461 / 2054 ms**, worst turn 3.7 s (Vapi), 0 overlaps |

  Morning breakdown (p50): transcriber/EOT ~397 ms, model TTFT ~473 ms, voice ~253 ms, plus `waitSeconds`.
- **Cut-ins, corrected.** call-report had Vapi's two interruption counters swapped. Per the spec, `numUserInterrupted` is "the user was interrupted by the assistant". So the morning call had **1 Ava cut-in** and **4 caller barge-ins**.
  - The cut-in followed a complete question ("What'd you say?") that the caller then continued, exactly the case a higher end-of-turn confidence targets.
  - All 4 barge-ins came during Ava turns of 8–14 s, fixed in the prompt: one or two short sentences, about 25 words, one-sentence recaps.
- **Decision: two presets** (`--endpointing fast|safe`, `vapi/variants/endpointing/`). **`fast` is the default since Oct 21** (it was `safe`): on two live calls, fast beat safe on every measure (see the table below and TESTING.md).

  | Preset | Flux `eotThreshold` | `eotTimeoutMs` | `waitSeconds` | Expected |
  |---|---|---|---|---|
  | `fast` (default) | **0.7** | **3000** | **0.2** | Live: p50 1461 / p95 2054 ms, 0 overlaps, and the caller said it felt much better |
  | `safe` | 0.8 | 4000 | 0.2 | Deepgram: 0.8–0.9 = "fewer false positives, slightly increased latency". Live: p50 1501 / p95 2941 ms, no fewer overlaps (0). Kept for callers who pause a lot mid-sentence |

  `waitSeconds` doesn't prevent cut-ins once Flux has decided the turn ended (the morning cut-in happened with 0.3), so both presets use 0.2.
- **"Transcriber p95 ~2.6 s" is a measurement artifact, not a delay** (Vapi's log, both afternoon calls). Vapi's `transcriberLatency` is `transcriberLatencyFromUserSpeech`, anchored at its own VAD event, not at the end of the caller's speech:
  - Call `01a15ee6` turn 7: 2603 ms = Flux EndOfTurn (77.654 s) − the caller's speech *start* (75.051 s). It includes the caller's own 2.5 s sentence.
  - Call `01a15edf` turn 1: 4641 ms = EndOfTurn (14.051 s) − a mid-sentence VAD "stopping" event (9.411 s). The VAD lost the caller's soft continuation ("um, actually lives with me"), and the caller kept talking until ~13.8 s.
  - On both turns Flux sent EndOfTurn ~0.2 s after the end of the audio it had seen. The caller-side wait (caller stops → Ava starts) is unaffected: p50 1.46–1.50 s.
  - **No change on our side.** The real end-of-turn delay is Flux's (eotThreshold, already at Deepgram's default 0.7 in `fast`). The large figures are how Vapi labels its metric; this is documented as a provider measurement quirk. call-report's caller-side wait is the number to watch.
- **Flux keyterms are confirmed.** The call log shows Vapi's `wss://api.deepgram.com/v2/listen?model=flux-general-en…` URL carrying all 48 keyterms.
- **Tool overhead** (Vapi's log, `serverMessage.requestSucceeded.latencyMs`). The tool-calls webhook took 984–1274 ms (p50 999 ms). Of that:
  - **Writing the arguments isn't the cost:** 88 ms from first token to tool call.
  - **Transport:** webhooks our handler answers instantly (`phone-call-control`, `status-update`) still took 560–664 ms. That's the Vapi → Replit edge (Google LB) → VM → back cost, outside our code.
  - **Ours: ~0.4–0.7 s per tool call.** A production probe of `/api/health` showed one query taking 27 ms warm but 240–251 ms after more than 30 s idle: the Postgres pool closed idle connections after 30 s and reconnected. Tool calls in a phone call are often more than 30 s apart. **Fixed:** `idleTimeoutMillis` is now 10 minutes, with `keepAlive` and a pool `error` handler. Each tool runs several sequential ~27 ms queries (idempotency lookup, handler queries, invocation record), because the database isn't in the VM's region.
  - **Vapi waits for the filler to finish speaking** before continuing (`tool.completed` = filler stop), so a fast tool still costs the length of its filler. Fillers are already 1–3 words.
  - Our tool requests now log `received_at`, Vapi's `vapi_sent_at`, `inbound_ms` and `request_ms` (event `tools_request`) next to `tool_invocation`'s handler and DB split, so the next call can be decomposed exactly.
  - **Remaining, infra:** co-locating the database with the VM, or moving both near Vapi (us-west-2), would cut the per-query and transport legs. Not changed in code.

### ADR-12: Model: gpt-4.1 over gpt-4.1-mini

- **Context.**
  - The morning call's model time to first token was p50 ~473 ms on gpt-4.1. gpt-4.1-mini would save roughly 0.2 s per turn.
  - Against that: the prompt carries ~20 behavioural rules the backend can't enforce (call order, verify-before-disclose wording, read-back, no invented facts, one outcome per call), and 7 tools with multi-step sequencing.
  - Errors we've seen live are all instruction-following errors: re-asking verified data, invented policy, two outcomes on one call, parroting a misheard word. Those get more likely, not less, with a smaller model.
- **Decision.** Keep **gpt-4.1** as the default (owner's call, Oct 21). Latency work goes into endpointing, turn length, the DB pool and caching instead. `gpt-4.1-mini` and `gpt-5.4-mini` remain `--variant`s for measured A/B tests, never silent switches.
- **Tradeoff.** About 0.2 s per turn in exchange for accuracy on a call where a wrong booking or a missed safety cue costs far more.

## Data model (short)

| Table | Written by | Read by |
|---|---|---|
| `customers`, `service_addresses`, `memberships`, `equipment` | seed, `book_appointment` (new callers and addresses) | `lookup_customer`, console |
| `appointment_slots` | seed | `triage_issue`, `get_availability`, `book_appointment` (atomic claim) |
| `appointments` (`intake` jsonb, `technician_notes`) | `book_appointment` | `lookup_customer` (next appointment), console |
| `dispatch_requests` | `triage_issue` (safety stop), `create_priority_dispatch` | dispatch board |
| `callback_requests` | `create_callback_request` | dispatch board |
| `tool_invocations` | dispatcher (every call, with latency) | idempotency, verification lockout, call timeline |
| `calls` | `end-of-call-report` | calls list, call detail |
