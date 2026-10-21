ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "completion" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "completion_note" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "status_by" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "rescheduled_from" uuid;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "called_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "called_back_by" text;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "resolution" text;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "resolution_note" text;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "resolved_by" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "is_simulation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "resolution" text;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "resolution_note" text;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "resolved_by" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "is_simulation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Back-fill: calls whose stored report says they weren't phone calls (web calls, websocket simulations).
UPDATE "calls" SET "is_simulation" = true
 WHERE NOT "is_simulation"
   AND coalesce("raw_report"->'call'->>'type', "raw_report"->>'type') IN ('webCall', 'vapi.websocketCall');--> statement-breakpoint
UPDATE "tool_invocations" SET "is_simulation" = true
 WHERE NOT "is_simulation"
   AND "vapi_call_id" IN (SELECT "vapi_call_id" FROM "calls" WHERE "is_simulation");
