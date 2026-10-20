# Summit Air: AI phone agent backend

Summit Air is a fictional residential HVAC company serving Brooklyn, Queens and Staten Island. This app is the backend for its AI phone agent. **Vapi** handles the voice call and calls our authenticated HTTP tools. This **Next.js** app owns every business rule and all Postgres persistence.

M1 status: deployable skeleton. A Vapi call can invoke `lookup_customer` and `check_service_area`, which read Postgres, record each invocation, and save the end-of-call report.

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
| `ON_CALL_TRANSFER_NUMBER` | no | E.164, for future human transfer |
| `TEST_DATABASE_URL` | no (tests) | Default `postgres://localhost:5432/summit_air_test`. The name must contain "test" |

## Scripts

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Next.js. `start` binds `0.0.0.0:$PORT` (default 3000) |
| `start:deploy` | `db:migrate` then `start` (used by Replit) |
| `lint` / `typecheck` / `test` | ESLint / `next typegen && tsc` / Vitest |
| `db:generate` | drizzle-kit: generate SQL migration from `src/server/db/schema.ts` into `drizzle/` |
| `db:migrate` | Apply migrations (plain Node + drizzle-orm migrator, advisory-locked) |
| `db:seed` | Idempotent fictional demo data: 12 customers, ZIPs, 10 business days of slots |

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

**Events and config.**

- `POST /api/vapi/events` upserts `end-of-call-report` into `calls`.
- Business assumptions (service ZIPs, heat season, SLA, residential-only) live in `src/config/business.ts`.

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

See `vapi/`: `system-prompt.md` (v0) and the function tool definitions in `vapi/tools/*.json`. Replace `{{APP_URL}}` and the `credentialId` placeholder when you paste them into Vapi.
