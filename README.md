# Summit Air: AI phone agent backend

Summit Air is a fictional residential HVAC company serving Brooklyn, Queens and Staten Island. This app is the backend for its AI phone agent. **Vapi** handles the voice call and calls our authenticated HTTP tools. This **Next.js** app owns every business rule and all Postgres persistence.

Status (M4): full call workflow plus a staff operations console. A call can identify the caller (caller ID or last name, verified by the street address the caller says), triage the issue deterministically, offer and book arrival windows atomically, log priority dispatches and callbacks, transfer to on-call, and save the end-of-call report. Staff work the results in a password-protected console (dispatch board, calls, appointments, overview). Vapi config (prompt, tools, assistant) is code in `vapi/`, synced with `npm run vapi:sync`.

## Setup (local)

Requirements: Node 20.19+ and a local Postgres (developed against Homebrew `postgresql@17`; 16 also works).

```bash
npm install
createdb summit_air_dev          # tests create summit_air_test automatically
cp .env.example .env             # then set VAPI_TOOL_SECRET and DASHBOARD_PASSWORD
npm run db:migrate
npm run db:seed
npm run dev                      # http://localhost:3000 (console login), /api/health
```

## Environment variables

Validated with Zod in `src/lib/env.ts`. The server exits at boot if any are invalid.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://…` |
| `VAPI_TOOL_SECRET` | yes | 16+ chars. Vapi sends it as `Authorization: Bearer …` |
| `DASHBOARD_PASSWORD` | yes | 8+ chars. The operations console password. Session cookies are signed with a key derived from it, so changing it signs everyone out |
| `APP_URL` | yes | Public base URL, e.g. `https://summit-air.replit.app` |
| `APP_TIMEZONE` | no | Default `America/New_York` |
| `ON_CALL_TRANSFER_NUMBER` | no | E.164. Set = triage offers transfer and `vapi:sync` attaches `transfer_to_on_call`. Unset = callbacks only |
| `DEMO_CALLER_PHONES` | no | `<phone>=<customer uuid>,...`: real phones that resolve to seeded demo customers. Never commit real numbers |
| `ASSISTANT_REQUEST_ENABLED` | no | Default `false`. `/api/vapi/assistant-request` tells the prompt the caller ID is recognized (no account details) |
| `VAPI_ASSISTANT_ID` | for assistant-request / sync | The saved Vapi assistant |
| `VAPI_API_KEY`, `VAPI_CREDENTIAL_ID` | sync only | Local `.env` only, for `npm run vapi:sync`. Not needed on the server |
| `TEST_DATABASE_URL` | no (tests) | Default `postgres://localhost:5432/summit_air_test`. The name must contain "test" |

## Scripts

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Next.js. `start` binds `0.0.0.0:$PORT` (default 3000) |
| `start:deploy` | `db:migrate` then `start` (used by Replit) |
| `lint` / `typecheck` / `test` | ESLint / `next typegen && tsc` / Vitest |
| `db:generate` | drizzle-kit: generate SQL migration from `src/server/db/schema.ts` into `drizzle/` |
| `db:migrate` | Apply migrations (plain Node + drizzle-orm migrator, advisory-locked) |
| `db:seed` | Idempotent fictional demo data: 13 customers, ZIPs, 10 business days of slots, and demo call activity for the console (9 ended calls covering every outcome, 1 in progress, board items, 4 upcoming appointments). Demo activity is replaced on each run, timed relative to now |
| `db:reset-test` | Deletes everything calls created and keeps seed data (including the demo call activity): calls, tool_invocations, appointments (seats given back to their slots), dispatch and callback requests, and non-seed customers/addresses/memberships. Prints counts. Dry run unless `-- --confirm`. Runs against `DATABASE_URL`, so on Replit it cleans production |
| `vapi:sync` | Upsert Vapi tools by name, update + publish the assistant, print the version. `-- --dry-run` diffs only; `-- --offline` renders locally without an API key |

## Architecture

Vapi POSTs `tool-calls` messages to `POST /api/vapi/tools`.

**Request handling.** The route file is a thin wrapper around `src/server/vapi/http.ts`. That module does three things:

- Checks the bearer secret in constant time.
- Logs the envelope's key names. It never logs values.
- Hands the body to the dispatcher (`src/server/vapi/dispatcher.ts`).

**Dispatcher.** The dispatcher works through these steps:

1. Parses `toolCallList`. Arguments can arrive as an object or a JSON string.
2. Computes the idempotency key `callId:tool:sha256(canonicalJSON(args))` and replays a stored result if one exists.
3. Looks up `{ schema, handler }` in the registry (`src/server/vapi/registry.ts`).
4. Validates with Zod. Errors name the bad fields so the agent can re-ask.
5. Runs the handler and records the call in `tool_invocations` with its latency.
6. Always answers HTTP 200 with `{ results: [{ toolCallId, result | error }] }`. Each value is a single-line JSON string with `ok`, the data, and an optional `say` hint for the agent.

**Business logic and data.**

- Tool logic lives in `src/server/services/`. Pure functions (for example `buildCallerContext` and `evaluateServiceArea`) are kept apart from data access.
- Data access sits behind the repository interfaces in `src/server/repositories/`, which are the only place Drizzle is used.
- `caller-context.ts` makes two DB round trips and reports `dbMs`, so it can later back a Vapi `assistant-request` greeting endpoint. That request has a hard 7.5 s budget.

**Call workflow tools (M2).**

| Tool | What it does |
|---|---|
| `lookup_customer` | Identity verification. Caller ID (or a stated phone), or last name (ZIP optional; derived from the matched address, `ambiguous` + `needs: "zip"` if several match). The **caller** must say their street address. The backend compares it (spoken and speech-to-text forms allowed: "thirty-seven twelve" = 37-12, "37 12 80 second Street" = 37-12 82nd St) and returns account details only when `verified: true`. Unverified results disclose nothing, and a call locks after 3 failed attempts. A `DEMO_CALLER_PHONES` alias always wins over any customer with that phone |
| `triage_issue` | Pure rules in `src/server/triage/rules.ts` → `urgency`, human-readable `reasons`, `next_action`; bookable outcomes include up to 3 `offered_slots` so routine calls need one tool call. A safety stop also records a `dispatch_requests` row. See "Triage requirement mapping" |
| `get_availability` | Later / morning / afternoon / weekday follow-ups |
| `book_appointment` | Requires `caller_confirmed: true`. One transaction: upsert customer by phone, match or add the address, `UPDATE … SET booked = booked + 1 WHERE booked < capacity (minus member-held seat) RETURNING`, insert appointment with dispatch-ready `technician_notes`. Idempotent; `slot_taken` returns 3 alternatives |
| `create_priority_dispatch` | Open emergency `dispatch_requests` row; returns the callback SLA as policy, never "technician en route" |
| `create_callback_request` | Office callback for failures, out-of-area, human requests, incomplete calls |
| `transfer_to_on_call` | Vapi `transferCall` (blind). Destination injected at sync time |

All tools treat `""`, whitespace-only and `null` in an optional field as omitted (`optionalArg` in `src/server/lib/optional-arg.ts`), since models send `access_notes: ""` for fields they don't have. A blank *required* field is still an error naming the field.

Every `tool_invocation` log line splits the time: `total_ms`, `idempotency_ms`, `handler_ms`, `db_ms` (the handler's repository time) and `record_ms`. `latency_ms` (also stored in `tool_invocations`) is everything before the result is recorded.

### Triage requirement mapping

| Situation | Urgency → next step | Rule |
|---|---|---|
| Gas smell, CO alarm, burning smell or smoke | `safety_stop` → leave-now instructions, no booking | Overrides everything, any season |
| No heat, heat season (Oct 1 – May 31), vulnerable occupant | `emergency` → priority dispatch | |
| No heat, indoor ≤ 55°F | `emergency` → priority dispatch | Any season |
| No heat, heat season | `urgent` → earliest window (48h) | |
| No heat, vulnerable occupant, outside heat season | `urgent` → earliest window | Spec: vulnerable occupants make it at least urgent |
| No AC, medically vulnerable (elderly, infant, medical condition, medical equipment), in cooling season (Jun 1 – Sep 30) or indoor ≥ 85°F | `emergency` → priority dispatch | |
| No AC, **any** vulnerable occupant (incl. pregnant, disability) | `urgent` → earliest window | Spec: "no AC with a medical condition or elderly resident" is urgent **regardless of season** |
| No AC, cooling season | `urgent` → earliest window | |
| Active leak | `urgent` → earliest window | |
| No heat / no AC out of season with nobody vulnerable, maintenance, noise, thermostat, other | `routine` → standard windows (14 days) | |
| Commercial property or ZIP outside the service area | urgency kept, `explain_and_close` | Residential only; Brooklyn, Queens, Staten Island |

Vulnerable occupants: elderly, infant, medical condition, pregnant, medical equipment, disability. Reasons name the vulnerability, e.g. "No cooling with vulnerable occupants: elderly (urgent in any season)".

Slot selection (`src/server/scheduling/availability.ts`) is pure. It enforces lead time, the 48h urgent window, and member priority: the last seat in any window inside 48h is held for active members, and the same rule is enforced in the atomic claim.

**Vapi config as code.** `vapi/system-prompt.md` is a template. `<<FACTS>>` placeholders are filled from `src/config/business.ts` at sync time, and `{{ }}` is left for Vapi Liquid. `vapi/tools/*.json` and `vapi/assistant.json` use `${APP_URL}`, `${VAPI_CREDENTIAL_ID}` and `${ON_CALL_TRANSFER_NUMBER}`, filled at sync time. A test checks each tool's JSON parameters against the server's Zod schema (`z.toJSONSchema`), so they can't drift.

**Events and config.**

- `POST /api/vapi/events` upserts `end-of-call-report` into `calls`.
- **Keep-warm.** The assistant also sends `status-update`. On status `in-progress` (the call just connected) the events handler starts a non-blocking `select 1` and answers at once, so a suspended production database wakes up during the greeting instead of on the first tool call. Only one ping runs at a time; other statuses are ignored without touching the database.
- Business assumptions (service ZIPs, heat season, SLAs, residential-only) live in `src/config/business.ts`.

**Schema changes.** Migrations must be idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`): Replit applies its own schema diff to the production database before `db:migrate` runs, so a migration may find its columns already there. After `npm run db:generate`, edit the SQL to add `IF NOT EXISTS`.

## Operations console (M4)

Staff UI at `/` (redirects to `/dispatch`). Server components read through `src/server/repositories/console.ts` (read-only queries); derivations are pure functions in `src/server/console/` (board order and SLA, call outcome, display formatting). Pages poll every 5 seconds with `router.refresh()` while the tab is visible ("Live" in the header), and rows that arrive after a list was first seen fade in from a soft highlight. Times are shown in `APP_TIMEZONE` (America/New_York).

| Page | What it shows |
|---|---|
| `/dispatch` | Priority board: open and acknowledged `dispatch_requests` plus open `callback_requests`, ordered safety stop → emergency → urgent → untriaged callbacks, oldest first. Each card has caller, phone, address with unit and access notes, vulnerable occupants, triage reasons, time waiting, and an overdue flag against the SLA (`priorityDispatchCallbackSlaMinutes` for dispatches until acknowledged, `callbackRequestSlaMinutes` for callbacks). Actions: Acknowledge, Resolve, Mark done |
| `/calls` | Every call (end-of-call report and/or tool activity), newest first: time, caller, issue, urgency, outcome. "In progress" while there is tool activity but no report yet; "No report" if a call has been quiet for 20 minutes without one |
| `/calls/[id]` | Tool timeline (tool, key args, ok/error, `latency_ms` total and `db_ms`), triage reasons, Vapi summary and transcript |
| `/appointments` | Upcoming confirmed appointments grouped by day: window, customer and member badge, address and access notes, service type, urgency, technician notes |
| `/overview` | Today's calls, bookings, priority requests, open callbacks, average and p95 tool latency, and a recent activity feed |

**Call outcome** (`src/server/console/outcome.ts`), most significant first: safety stop (a `safety_stop` dispatch or safety triage) > booked (confirmed appointment) > priority dispatch (`emergency` dispatch) > callback > not serviceable (out of area or commercial) > incomplete. Records are the source of truth and successful tool results back them up.

**Auth.** `src/proxy.ts` (Next 16's renamed middleware) requires a session on everything except `/login`, `/api/vapi/*` and `/api/health`, which keep their own auth. The session cookie (`sa_session`, httpOnly, Secure, SameSite=Lax, 12 hours) is an HMAC-SHA256-signed expiry; the key is derived from `DASHBOARD_PASSWORD` with HKDF. The password check is constant time, and failed logins are limited to 5 per client per 15 minutes (in memory, keyed on the proxy-appended `X-Forwarded-For` entry). Server Actions and data loaders re-check the session themselves rather than relying on the proxy matcher.

**Seed data.** Demo rows carry `is_demo_seed` and show a "Seed" tag. The "Show seed data" switch in the header (a cookie) hides them from every page and KPI.

## Test personas (for reviewers calling from their own phones)

All data is fictional seed data (`npm run db:seed`).

**1. Map your phone to a persona.** Add `<your phone>=<customer id>` to `DEMO_CALLER_PHONES` on the server, comma-separated for several reviewers. Your caller ID then resolves to that persona.

**2. Verify on the call.** You still have to say the street address to be verified, exactly as a real customer would. Say it any natural way, for example "thirty-seven twelve eighty-second street".

**3. No mapping?** Say you're an existing customer and give your last name and street address (ZIP only if asked).

**Cleaning up after test calls.** Calls that fail verification and then book create real rows (a non-seed customer with your phone, appointments, callbacks). Run `npm run db:reset-test` to see counts, then `npm run db:reset-test -- --confirm` to delete them. Seed data survives.

| Persona | ZIP | Street address (say this to verify) | Membership | Good for |
|---|---|---|---|---|
| Dana Quillfeather | 11215 | 412 Seventh Ave, Brooklyn | Active, Comfort Club Plus | Returning member. Shares a last name and ZIP with Morgan Quillfeather (211 Prospect Park W), so name lookup must rely on the street |
| Priya Marlowe-Venn | 11372 | 37-12 82nd St, Jackson Heights | Active, Comfort Club | Queens hyphenated address, no heat (urgent in heat season) |
| Lena Okonkwo-Hart | 11230 | 1450 Ocean Ave, Apt 5C, Brooklyn | Non-member | Routine maintenance; apartment with buzzer/super access notes |
| Marcus Thistlewood | 10314 | 88 Rockrose Ave, Staten Island | Lapsed | No heat + elderly parent (emergency → priority dispatch); street spell-back |
| Sam Fernhollow | 11201 | 251 Atlantic Ave (storefront), Brooklyn | Non-member, **commercial** | Commercial caller → politely declined |

### Suggested scenarios

1. **Routine maintenance (new caller).** Call from an unmapped phone, ask for a furnace tune-up at a made-up address in ZIP 11215 or 11372.
   - Expect: 3 offered windows after a single `triage_issue`, a full read-back, then a booking.
   - Afterwards: check `appointments.technician_notes`.
2. **Returning member.** As Dana, report a noisy mini-split and verify with "four twelve seventh avenue".
   - Expect: greeted by first name only after verification, member slots offered, booking linked to her account.
   - Also try: a wrong street should get no hints, and three wrong tries lock verification for the call.
3. **No heat + elderly parent.** As Marcus, say the heat's out and your 82-year-old father lives with you.
   - Expect: `emergency` → `create_priority_dispatch`. The caller hears the 15-minute callback policy, with no claim that a technician is on the way.
   - Expect a transfer offer only if `ON_CALL_TRANSFER_NUMBER` is set.
4. **Gas smell.** Any persona: "I think I smell gas."
   - Expect: immediate leave-now / call-911-from-outside instructions before any tool call, then a `safety_stop` dispatch row.
   - Expect no booking, and an explicit statement that Summit Air has not called 911.
5. **Commercial caller.** As Sam (or anyone), ask for AC repair at your restaurant.
   - Expect: explained and closed, no booking.

## Testing

Tests run against a **real Postgres test database** (`summit_air_test`). Vitest global setup creates, migrates and seeds it.

- **Why a real database:** the logic most likely to break in M1 is SQL. Mocked repositories would only test the mocks. That includes:
  - the phone unique-index lookup
  - the address and equipment join
  - enum ordering
  - `ON CONFLICT` idempotency and the replay of an `internal_error`
  - the end-of-call upsert that keeps existing values with `COALESCE`
- **Pure logic** (envelope parsing, phone normalization, canonical JSON, service-area rules) also has plain unit tests with no DB.
- **Repository interfaces** still allow in-memory fakes later if the suite gets slow.

The suite takes about 2 s locally.

## Vapi configuration

**Persona.** The agent is "Ava, Summit Air's virtual assistant" (prompt "How you speak"; greeting in `vapi/assistant.json`; model temperature 0.5). It says it's an AI if asked.

**Greeting clipping.** Vapi has no first-message delay setting for inbound calls (checked against the API spec, Oct 2026: only `firstMessage`, `firstMessageMode` and `firstMessageInterruptionsEnabled`). The greeting opens with skippable words ("Hi, thanks for calling…") so a clipped start loses nothing. Untested fallbacks: a `firstMessage` audio URL that starts with ~0.5 s of silence, or a leading `<break time="600ms"/>` (Cartesia supports it).

**Voice options** (`voice.provider` / `voice.voiceId`; all work through Vapi's built-in integration, no provider key needed unless you use a cloned/custom voice). Vapi's pricing calculator lists voice cost per minute as roughly Vapi $0.007–0.019, Cartesia $0.007–0.013, ElevenLabs $0.015–0.024, on top of Vapi's platform fee.

| Voice | provider / voiceId | Notes |
|---|---|---|
| Emma (current placeholder) | `vapi` / `Emma`, `"version": "2"` | Young American female, "natural, friendly". V2 is Vapi's newer, cheaper model |
| Clara | `vapi` / `Clara`, `"version": "2"` | Adult American female, "natural, professional" |
| Savannah | `vapi` / `Savannah`, `"version": "2"` | Young American female, "natural, friendly" |
| Jacqueline | `cartesia` / `9626c31c-bec5-4cca-baa8-f8ba9e84c8bc` | Cartesia lists it as a stable voice for agents (model `sonic-3`) |
| Katie | `cartesia` / `f786b574-daa5-4673-aa0c-cbe3e8534c02` | Cartesia's recommended agent voice |
| ElevenLabs | `11labs` / a Voice Library ID | Presets like `sarah`/`matilda` are ElevenLabs "default voices", which ElevenLabs says expire Dec 31, 2026. Pick a library voice (e.g. "Talia – Warm Soft Guide") and copy its ID from the Vapi dashboard |

Naturalness settings: `speed` (Vapi 0.25–2; ElevenLabs 0.7–1.2; Cartesia `generationConfig.speed` 0.6–1.5 on sonic-3), ElevenLabs `stability` (0–1, ~0.5 for expressive but steady) / `similarityBoost` / `style`, and `chunkPlan` (all providers). We send TTS whole sentences (no comma boundaries) to avoid choppy delivery. `fillerInjectionEnabled` no longer exists in Vapi's API.

Don't paste files by hand. Run `npm run vapi:sync -- --dry-run`, review the diff, then `npm run vapi:sync`. Through the API, every assistant update with changed content publishes a new Vapi version immediately. The script prints the version.

Optional assistant-request: set `ASSISTANT_REQUEST_ENABLED=true` and `VAPI_ASSISTANT_ID` on the server. Then point the phone number's server URL at `/api/vapi/assistant-request` (with the same credential) and clear its assistant. Because callers aren't verified at greeting time, it sends only `caller_recognized` and never a name or address. It answers within 1.5 s or falls back to the plain assistant.
