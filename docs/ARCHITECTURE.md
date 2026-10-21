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

### ADR-10: Call endings: one goodbye via endCall, then a padded hang-up we control

- **Context.**
  - **Round 1 (Oct 21).** The model said its own goodbye, then Vapi's goodbye was cut off mid-word ("Take").
  - **Round 2, live evidence.** **The recording had the full goodbye, but on the phone it was cut off at hang-up.** `npm run call-report` showed why: on every call, the `endCall` result (the hang-up) landed **0.15–0.67 s before** the goodbye audio's `endTime`. The carrier then dropped whatever audio was still in flight.
  - So: recording complete, phone path clipped. The fix is tail padding, not wording.
- **Decision.**
  1. **One goodbye.** The model never says goodbye itself. It calls `endCall`, whose `request-start` message is the closing line ("Thanks for calling Summit Air. Take care, and goodbye for now."). `endCallPhrases: ["goodbye for now"]` is a backstop if the model ever speaks the line itself. That phrase appears nowhere else (tested).
  2. **Tail padding on every ending path.**
     - The assistant requests `serverMessages: ["phone-call-control"]`, so Vapi delegates hang-up (and forwarding) to our events endpoint instead of hanging up itself (docs.vapi.ai/server-url/events, "Phone Call Control").
     - `src/server/vapi/call-control.ts` answers immediately, waits `HANGUP_TAIL_MS` (default **1500 ms**), then POSTs `{"type":"end-call"}` to the call's `monitor.controlUrl` (live call control). It retries once on failure.
     - 1.5 s covers the measured 0.67 s early hang-up plus ~0.8 s of silence for the carrier.
     - Every ending (normal goodbye, safety stop after the caller acknowledges, commercial decline, non-service call, abusive caller, end-call phrase) produces the same Vapi hang-up request, so all of them get the same padding. A test composes every model variant × voice × target and asserts each delegates hang-up the same way.
     - Delegated forwarding is handled too (`{"type":"transfer","destination":…}`), so transfers keep working when `ON_CALL_TRANSFER_NUMBER` is set.
  3. **Why not SSML.**
     - Vapi keeps `<break>` tags, but the current voice (Vapi Emma v2, possibly xAI-backed) uses different pause markup, and no provider documents that a *trailing* break produces real audio rather than being trimmed.
     - The control-URL route is provider-independent, so it also survives a voice switch.
- **Tradeoff.**
  - The hang-up now depends on our server. If the events endpoint is down, Vapi won't hang up, and the call lasts until the caller hangs up (they will, after the goodbye) or `maxDurationSeconds` (900).
  - Each call ends ~1.5 s later. That is billed time, and it's silent.
  - The combination of the two documented pieces (phone-call-control, then a control-URL end-call) isn't described as a single recipe in Vapi's docs. Verify on the first live call: `endedReason` and the phone should both show a clean, complete goodbye.

### ADR-11: Turn-taking and latency, measured

- **Context.** Median caller-stop → Ava-start was **2.03 s** on the "Conservative" LiveKit config (p95 3.18 s), and 1.65 s across the three latest calls (p95 3.5 s). Vapi's per-turn breakdown (`npm run call-report`) put the time here:
  - **Endpointing:** p50 727 ms, p95 2250 ms. The floor is the waitFunction's 700 ms constant, and 1.5 s entries came from the post-question rule. Before that change it was 101 ms with cut-ins. **Confirmed** as the main regression.
  - **Transcriber:** p50 300–500 ms, but p95 2.7–3.7 s and max 5 s on nova-3, on both configs. **Confirmed** as the tail.
  - **Model (gpt-4.1 time to first token):** p50 ~515–600 ms, p95 ~0.8–1.0 s. **Confirmed** as a steady cost.
  - **Voice:** p50 ~230 ms, p95 ~270 ms. **Refuted** as a meaningful cause. The `minCharacters: 30` chunk wait was small too, but it's lowered anyway.
  - **Tool turns:** the filler starts 1.0–1.35 s after the model's tool call, and Vapi sees results 1.0–2.5 s after the call while our handler takes 58–324 ms. That is overhead outside our code (network, Replit edge, Vapi), so this round doesn't change it beyond shorter fillers.
- **Decision.**
  - **End of turn: Deepgram Flux** (`flux-general-en`). Flux detects end of turn from audio and text together, replacing both LiveKit endpointing and the nova-3 finalization tail. Deepgram quotes ~260 ms EOT p50.
    - `eotThreshold: 0.7` is Deepgram's default and low-latency value. 0.5–0.6 is "aggressive" and risks cut-ins.
    - `eotTimeoutMs: 3000` is in the docs' "fast" band.
    - Per Vapi's docs, `smartEndpointingPlan`, `customEndpointingRules` and `transcriptionEndpointingPlan` don't apply with Flux, so they're removed. The dry run reports them while the live assistant still has them.
    - The 1.5 s post-question wait is gone: the numbers showed only cost, and Flux's model handles mid-number pauses.
  - **`waitSeconds: 0.3`**, the low end of Vapi's customer-service range (0.3–0.5). Try 0.2 if test calls show no cut-ins.
  - **Speech start:** `chunkPlan.minCharacters: 5` (was 30), and the prompt opens most replies with a 1–3 word sentence ("Got it.") so audio starts on it.
  - **Model:** `promptCacheRetention: "24h"` keeps the ~4,300-token prompt prefix cached between sparse calls; in-memory caching expires in minutes. The prompt keeps all per-call text last (98% cacheable prefix).
  - **A/B variants** (`npm run vapi:sync -- --variant …`):
    - `gpt-4.1` (default)
    - `gpt-4.1-mini`
    - `gpt-5.4-mini` with `reasoningEffort: "none"`, the newest small model, as an experiment, because Vapi publishes no tool-reliability data per model
    - `gpt-4.1-nova3`: the previous transcriber plus LiveKit's "Normal" curve, a fallback if Flux mis-hears names or cuts in
  - **Expected budget with the default:** ~0.3 s EOT + 0.3 s wait + ~0.4–0.5 s TTFT (cached) + ~0.23 s voice ≈ **1.1–1.3 s**. Reaching the < 1.0 s median target likely needs `gpt-4.1-mini` or `waitSeconds 0.2`. That's what the A/B is for.
- **Tradeoff.**
  - Flux's keyterm support is documented by Deepgram, but Vapi doesn't document forwarding `keyterm` to Flux. Check the first transcript for brand and street names, and fall back to `gpt-4.1-nova3` if they're wrong.
  - Smaller models may follow the long prompt less reliably. Run the evals before keeping one.

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
