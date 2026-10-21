# Contributor guide

Conventions, commands and guardrails for working in this repo. For the design, start with [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

| Task | Command |
|---|---|
| Install, migrate, seed | `npm install && npm run db:migrate && npm run db:seed` |
| Run locally | `npm run dev` |
| Checks before every change | `npm run lint && npm run typecheck && npm test && npm run build` |
| Review a Vapi change | `npm run vapi:sync -- --dry-run` |
| Publish a Vapi change | `npm run vapi:sync` |
| List or estimate evals (sends nothing) | `npm run evals` |
| Latency and hang-up report for a call | `npm run call-report -- latest` |

## Conventions

- **Code decides; the model talks.** Business rules (urgency, identity, availability, capacity, disclosure) live in TypeScript behind the tools, never only in the prompt ([ADR-1](docs/ARCHITECTURE.md#adr-1-the-model-decides-what-to-ask-the-backend-enforces-whats-true)).
- **Layers.** Services in `src/server/services/` compose pure rules (`src/server/triage/`, `src/server/scheduling/`) and repositories (`src/server/repositories/`, the only code that touches SQL).
- **Tool contract.** Every tool returns `{ ok, data, say }`, and every `say` ends with the next step. Optional arguments use `optionalArg`, so blanks count as omitted. Each tool's JSON in `vapi/tools/` must match its Zod schema (a test enforces it).
- **Safety paths fail open.** Routine paths may refuse invalid input; emergency and safety paths never block on missing fields and always leave a record ([ADR-9](docs/ARCHITECTURE.md#adr-9-safety-in-depth-emergencies-fail-open)).
- **Business assumptions** live in `src/config/business.ts`, each marked `ASSUMPTION`; the prompt's facts are generated from it.
- **Tests run against a real Postgres** (`summit_air_test`). Add a regression test for every bug found on a live call or in an eval.

## Guardrails

- **Vapi config is code.** Edit `vapi/`, review the dry-run diff, then sync. Never edit the assistant or tools in the Vapi dashboard; the next sync overwrites it.
- **Migrations are idempotent** (`IF NOT EXISTS`). Before every Replit republish, follow the README's Deploy steps, and stop if the publish dialog shows any `DROP` ([ADR-7](docs/ARCHITECTURE.md#adr-7-idempotent-migrations-and-the-replit-schema-diff)).
- **Secrets stay in `.env`.** Never commit keys, passwords or real phone numbers (`DEMO_CALLER_PHONES` lives on the server only). Logs record envelope key names, never argument values.
- **Evals and `db:reset-test` touch real systems.** `npm run evals -- --confirm` spends Vapi credits and writes rows through the live backend. `db:reset-test` runs against `DATABASE_URL`, so on Replit it cleans production.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
