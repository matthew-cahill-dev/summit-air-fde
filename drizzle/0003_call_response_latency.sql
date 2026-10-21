ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "response_p50_ms" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "response_p95_ms" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "response_turns" integer;