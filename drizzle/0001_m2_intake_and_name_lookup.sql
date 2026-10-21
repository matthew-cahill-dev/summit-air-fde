ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "intake" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_last_name_lower_idx" ON "customers" USING btree (lower("last_name"));