CREATE TYPE "public"."appointment_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."callback_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."equipment_kind" AS ENUM('furnace', 'boiler', 'central_ac', 'heat_pump', 'mini_split', 'other');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'lapsed');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('maintenance', 'repair', 'diagnostic');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('safety_stop', 'emergency', 'urgent', 'routine');--> statement-breakpoint
CREATE TABLE "appointment_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"county" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "appointment_slots_county_starts_at_key" UNIQUE("county","starts_at"),
	CONSTRAINT "appointment_slots_booked_le_capacity" CHECK ("appointment_slots"."booked" <= "appointment_slots"."capacity"),
	CONSTRAINT "appointment_slots_booked_nonnegative" CHECK ("appointment_slots"."booked" >= 0),
	CONSTRAINT "appointment_slots_window_order" CHECK ("appointment_slots"."ends_at" > "appointment_slots"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"service_type" "service_type" NOT NULL,
	"urgency" "urgency" NOT NULL,
	"issue_summary" text,
	"symptoms" jsonb,
	"technician_notes" text,
	"status" "appointment_status" DEFAULT 'confirmed' NOT NULL,
	"vapi_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_customer_slot_key" UNIQUE("customer_id","slot_id")
);
--> statement-breakpoint
CREATE TABLE "callback_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_phone" text,
	"caller_name" text,
	"reason" text,
	"context" jsonb,
	"status" "callback_status" DEFAULT 'open' NOT NULL,
	"vapi_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vapi_call_id" text NOT NULL,
	"caller_phone" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"summary" text,
	"transcript" text,
	"disposition" text,
	"raw_report" jsonb,
	"is_test" boolean DEFAULT true NOT NULL,
	CONSTRAINT "calls_vapi_call_id_unique" UNIQUE("vapi_call_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo_seed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "customers_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "dispatch_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"caller_phone" text,
	"caller_name" text,
	"address" jsonb,
	"urgency" "urgency" NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"intake" jsonb,
	"status" "dispatch_status" DEFAULT 'open' NOT NULL,
	"vapi_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address_id" uuid NOT NULL,
	"kind" "equipment_kind" NOT NULL,
	"brand" text,
	"install_year" smallint
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"status" "membership_status" NOT NULL,
	"started_on" date NOT NULL,
	"renews_on" date NOT NULL,
	"is_demo_seed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"line1" text NOT NULL,
	"unit" text,
	"city" text NOT NULL,
	"state" text DEFAULT 'NY' NOT NULL,
	"zip" text NOT NULL,
	"county" text,
	"property_type" "property_type" DEFAULT 'residential' NOT NULL,
	"access_notes" text,
	"is_demo_seed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "service_addresses_zip_format" CHECK ("service_addresses"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "service_area_zips" (
	"zip" text PRIMARY KEY NOT NULL,
	"county" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"vapi_call_id" text,
	"tool_name" text NOT NULL,
	"args" jsonb,
	"result" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_slot_id_appointment_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."appointment_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_address_id_service_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."service_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_address_id_service_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."service_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addresses" ADD CONSTRAINT "service_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_slot_id_idx" ON "appointments" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX "equipment_address_id_idx" ON "equipment" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "memberships_customer_id_idx" ON "memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "service_addresses_customer_id_idx" ON "service_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_vapi_call_id_idx" ON "tool_invocations" USING btree ("vapi_call_id");