// Full Summit Air schema. M1 only reads/writes customers, addresses,
// memberships, equipment, service_area_zips, calls and tool_invocations;
// the rest is designed now so later milestones don't need breaking migrations.
// Keep this file free of path aliases: it is also compiled for the seed script.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const urgencyEnum = pgEnum("urgency", ["safety_stop", "emergency", "urgent", "routine"]);
export const propertyTypeEnum = pgEnum("property_type", ["residential", "commercial"]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "lapsed"]);
export const equipmentKindEnum = pgEnum("equipment_kind", [
  "furnace",
  "boiler",
  "central_ac",
  "heat_pump",
  "mini_split",
  "other",
]);
export const serviceTypeEnum = pgEnum("service_type", ["maintenance", "repair", "diagnostic"]);
export const appointmentStatusEnum = pgEnum("appointment_status", ["confirmed", "cancelled"]);
export const dispatchStatusEnum = pgEnum("dispatch_status", ["open", "acknowledged", "resolved"]);
export const callbackStatusEnum = pgEnum("callback_status", ["open", "done"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phoneE164: text("phone_e164").notNull().unique(),
  email: text("email"),
  createdAt: createdAt(),
  isDemoSeed: boolean("is_demo_seed").notNull().default(false),
});

export const serviceAddresses = pgTable(
  "service_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    // Free text: must hold Queens hyphenated house numbers, e.g. "37-12 82nd St".
    line1: text("line1").notNull(),
    unit: text("unit"),
    city: text("city").notNull(),
    state: text("state").notNull().default("NY"),
    zip: text("zip").notNull(),
    county: text("county"),
    propertyType: propertyTypeEnum("property_type").notNull().default("residential"),
    accessNotes: text("access_notes"),
    isDemoSeed: boolean("is_demo_seed").notNull().default(false),
  },
  (t) => [
    index("service_addresses_customer_id_idx").on(t.customerId),
    check("service_addresses_zip_format", sql`${t.zip} ~ '^[0-9]{5}$'`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    planName: text("plan_name").notNull(),
    status: membershipStatusEnum("status").notNull(),
    startedOn: date("started_on").notNull(),
    renewsOn: date("renews_on").notNull(),
    isDemoSeed: boolean("is_demo_seed").notNull().default(false),
  },
  (t) => [index("memberships_customer_id_idx").on(t.customerId)],
);

export const equipment = pgTable(
  "equipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    addressId: uuid("address_id")
      .notNull()
      .references(() => serviceAddresses.id, { onDelete: "cascade" }),
    kind: equipmentKindEnum("kind").notNull(),
    brand: text("brand"),
    installYear: smallint("install_year"),
  },
  (t) => [index("equipment_address_id_idx").on(t.addressId)],
);

export const serviceAreaZips = pgTable("service_area_zips", {
  zip: text("zip").primaryKey(),
  county: text("county").notNull(),
  active: boolean("active").notNull().default(true),
});

export const appointmentSlots = pgTable(
  "appointment_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    county: text("county").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    capacity: integer("capacity").notNull(),
    booked: integer("booked").notNull().default(0),
  },
  (t) => [
    unique("appointment_slots_county_starts_at_key").on(t.county, t.startsAt),
    check("appointment_slots_booked_le_capacity", sql`${t.booked} <= ${t.capacity}`),
    check("appointment_slots_booked_nonnegative", sql`${t.booked} >= 0`),
    check("appointment_slots_window_order", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => appointmentSlots.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    addressId: uuid("address_id")
      .notNull()
      .references(() => serviceAddresses.id),
    serviceType: serviceTypeEnum("service_type").notNull(),
    urgency: urgencyEnum("urgency").notNull(),
    issueSummary: text("issue_summary"),
    symptoms: jsonb("symptoms"),
    technicianNotes: text("technician_notes"),
    status: appointmentStatusEnum("status").notNull().default("confirmed"),
    vapiCallId: text("vapi_call_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointments_customer_slot_key").on(t.customerId, t.slotId),
    index("appointments_slot_id_idx").on(t.slotId),
  ],
);

export const dispatchRequests = pgTable("dispatch_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").references(() => customers.id),
  callerPhone: text("caller_phone"),
  callerName: text("caller_name"),
  address: jsonb("address"),
  urgency: urgencyEnum("urgency").notNull(),
  reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
  intake: jsonb("intake"),
  status: dispatchStatusEnum("status").notNull().default("open"),
  vapiCallId: text("vapi_call_id"),
  createdAt: createdAt(),
});

export const callbackRequests = pgTable("callback_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  callerPhone: text("caller_phone"),
  callerName: text("caller_name"),
  reason: text("reason"),
  context: jsonb("context"),
  status: callbackStatusEnum("status").notNull().default("open"),
  vapiCallId: text("vapi_call_id"),
  createdAt: createdAt(),
});

export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  vapiCallId: text("vapi_call_id").notNull().unique(),
  callerPhone: text("caller_phone"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedReason: text("ended_reason"),
  summary: text("summary"),
  transcript: text("transcript"),
  disposition: text("disposition"),
  rawReport: jsonb("raw_report"),
  isTest: boolean("is_test").notNull().default(true),
});

export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    vapiCallId: text("vapi_call_id"),
    toolName: text("tool_name").notNull(),
    args: jsonb("args"),
    result: jsonb("result").notNull(),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("tool_invocations_vapi_call_id_idx").on(t.vapiCallId)],
);
