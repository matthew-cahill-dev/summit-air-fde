# Summit Air: AI phone agent backend

Summit Air is a fictional residential HVAC company serving Brooklyn, Queens and Staten Island. This app is the backend for its AI phone agent. **Vapi** handles the voice call and calls our authenticated HTTP tools. This **Next.js** app owns every business rule and all Postgres persistence.

Status (M2): full call workflow. A call can identify the caller (by phone or last name + ZIP/street number), triage the issue deterministically, offer and book arrival windows atomically, log priority dispatches and callbacks, transfer to on-call, and save the end-of-call report. Vapi config (prompt, tools, assistant) is code in `vapi/`, synced with `npm run vapi:sync`.

## Setup (local)

Requirements: Node 20.19+ and a local Postgres (developed against Homebrew `postgresql@17`; 16 also works).

```bash
npm install
createdb summit_air_dev          # tests create summit_air_test automatically
cp .env.example .env             # then set VAPI_TOOL_SECRET and DASHBOARD_PASSWORD
npm run db:migrate
npm run db:seed
npm run dev                      # http://localhost:3000, /api/health
```

## Environment variables

Validated with Zod in `src/lib/env.ts`. The server exits at boot if any are invalid.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://…` |
| `VAPI_TOOL_SECRET` | yes | 16+ chars. Vapi sends it as `Authorization: Bearer …` |
| `DASHBOARD_PASSWORD` | yes | 8+ chars, for the future staff dashboard |
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
| `db:seed` | Idempotent fictional demo data: 13 customers, ZIPs, 10 business days of slots |
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
| `lookup_customer` | Identity verification. Caller ID (or a stated phone), or last name + ZIP. The **caller** must say their street address. The backend compares it (spoken numbers allowed: "thirty-seven twelve" = 37-12) and returns account details only when `verified: true`. Unverified results disclose nothing, and a call locks after 3 failed attempts. `DEMO_CALLER_PHONES` aliases real phones to demo customers |
| `triage_issue` | Pure rules in `src/server/triage/rules.ts` → `urgency`, human-readable `reasons`, `next_action`; bookable outcomes include up to 3 `offered_slots` so routine calls need one tool call. A safety stop also records a `dispatch_requests` row |
| `get_availability` | Later / morning / afternoon / weekday follow-ups |
| `book_appointment` | Requires `caller_confirmed: true`. One transaction: upsert customer by phone, match or add the address, `UPDATE … SET booked = booked + 1 WHERE booked < capacity (minus member-held seat) RETURNING`, insert appointment with dispatch-ready `technician_notes`. Idempotent; `slot_taken` returns 3 alternatives |
| `create_priority_dispatch` | Open emergency `dispatch_requests` row; returns the callback SLA as policy, never "technician en route" |
| `create_callback_request` | Office callback for failures, out-of-area, human requests, incomplete calls |
| `transfer_to_on_call` | Vapi `transferCall` (blind). Destination injected at sync time |

Slot selection (`src/server/scheduling/availability.ts`) is pure. It enforces lead time, the 48h urgent window, and member priority: the last seat in any window inside 48h is held for active members, and the same rule is enforced in the atomic claim.

**Vapi config as code.** `vapi/system-prompt.md` is a template. `<<FACTS>>` placeholders are filled from `src/config/business.ts` at sync time, and `{{ }}` is left for Vapi Liquid. `vapi/tools/*.json` and `vapi/assistant.json` use `${APP_URL}`, `${VAPI_CREDENTIAL_ID}` and `${ON_CALL_TRANSFER_NUMBER}`, filled at sync time. A test checks each tool's JSON parameters against the server's Zod schema (`z.toJSONSchema`), so they can't drift.

**Events and config.**

- `POST /api/vapi/events` upserts `end-of-call-report` into `calls`.
- Business assumptions (service ZIPs, heat season, SLA, residential-only) live in `src/config/business.ts`.

## Test personas (for reviewers calling from their own phones)

All data is fictional seed data (`npm run db:seed`).

**1. Map your phone to a persona.** Add `<your phone>=<customer id>` to `DEMO_CALLER_PHONES` on the server, comma-separated for several reviewers. Your caller ID then resolves to that persona.

**2. Verify on the call.** You still have to say the street address to be verified, exactly as a real customer would. Say it any natural way, for example "thirty-seven twelve eighty-second street".

**3. No mapping?** Use last name + ZIP + street address instead.

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

Don't paste files by hand. Run `npm run vapi:sync -- --dry-run`, review the diff, then `npm run vapi:sync`. Through the API, every assistant update with changed content publishes a new Vapi version immediately. The script prints the version.

Optional assistant-request: set `ASSISTANT_REQUEST_ENABLED=true` and `VAPI_ASSISTANT_ID` on the server. Then point the phone number's server URL at `/api/vapi/assistant-request` (with the same credential) and clear its assistant. Because callers aren't verified at greeting time, it sends only `caller_recognized` and never a name or address. It answers within 1.5 s or falls back to the plain assistant.
