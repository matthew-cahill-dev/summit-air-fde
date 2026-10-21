ALTER TABLE "appointments" ADD COLUMN "intake" jsonb;--> statement-breakpoint
CREATE INDEX "customers_last_name_lower_idx" ON "customers" USING btree (lower("last_name"));