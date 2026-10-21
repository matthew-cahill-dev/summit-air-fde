ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "is_demo_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "is_demo_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "is_demo_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD COLUMN IF NOT EXISTS "is_demo_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "db_ms" integer;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "is_demo_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_vapi_call_id_idx" ON "appointments" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "callback_requests_status_idx" ON "callback_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "callback_requests_vapi_call_id_idx" ON "callback_requests" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatch_requests_status_idx" ON "dispatch_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatch_requests_vapi_call_id_idx" ON "dispatch_requests" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_created_at_idx" ON "tool_invocations" USING btree ("created_at");