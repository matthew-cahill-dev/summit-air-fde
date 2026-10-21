// Repository interfaces: the only boundary between services and the database.
// Services depend on these types; implementations live next to this file.

export type CustomerRow = {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string;
};

export type MembershipRow = {
  planName: string;
  status: "active" | "lapsed";
  startedOn: string;
  renewsOn: string;
};

export type EquipmentRow = {
  kind: "furnace" | "boiler" | "central_ac" | "heat_pump" | "mini_split" | "other";
  brand: string | null;
  installYear: number | null;
};

export type AddressRow = {
  id: string;
  line1: string;
  unit: string | null;
  city: string;
  zip: string;
  county: string | null;
  propertyType: "residential" | "commercial";
  accessNotes: string | null;
  equipment: EquipmentRow[];
};

export type CallerContextRows = {
  customer: CustomerRow;
  memberships: MembershipRow[];
  addresses: AddressRow[];
};

export interface CustomerRepository {
  /** Exact match on phone_e164. Returns null when no customer has that number. */
  findCallerContextByPhone(phoneE164: string): Promise<CallerContextRows | null>;
  findCallerContextByCustomerId(customerId: string): Promise<CallerContextRows | null>;
  /** Case-insensitive last-name match, optionally narrowed to a ZIP. One row per (customer, address). */
  findByLastName(input: {
    lastName: string;
    zip?: string;
  }): Promise<Array<{ customerId: string; addressId: string; line1: string; zip: string }>>;
  /** The customer's earliest confirmed appointment whose window hasn't ended by `after`. */
  findNextAppointment(customerId: string, after: Date): Promise<{ startsAt: Date; endsAt: Date } | null>;
}

export interface ServiceAreaRepository {
  findZip(zip: string): Promise<{ zip: string; county: string; active: boolean } | null>;
}

export type StoredInvocation = {
  idempotencyKey: string;
  toolName: string;
  ok: boolean;
  /** The payload object that was stringified into result/error. */
  result: Record<string, unknown>;
};

export interface ToolInvocationRepository {
  findByKey(key: string): Promise<StoredInvocation | null>;
  /**
   * Insert the invocation. If the key already exists, only a prior transient
   * failure (error_code "internal_error") is overwritten. Returns the row that
   * is now stored, which may be a concurrent winner's.
   */
  record(input: {
    idempotencyKey: string;
    vapiCallId: string | null;
    toolName: string;
    args: unknown;
    ok: boolean;
    result: Record<string, unknown>;
    latencyMs: number;
    /** The handler's repository time, for the console's call timeline. */
    dbMs?: number;
  }): Promise<StoredInvocation>;
  /** Failed identity checks so far on this call (results with verification_failed: true). */
  countFailedVerifications(vapiCallId: string): Promise<number>;
}

export type EndOfCallReport = {
  vapiCallId: string;
  callerPhone: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  rawReport: unknown;
};

export interface CallRepository {
  upsertEndOfCallReport(report: EndOfCallReport): Promise<void>;
}

export type SlotRow = {
  id: string;
  county: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
};

export type Urgency = "safety_stop" | "emergency" | "urgent" | "routine";
export type DispatchStatus = "open" | "acknowledged" | "resolved";
export type CallbackStatus = "open" | "done";

export type DispatchInput = {
  customerId: string | null;
  callerPhone: string | null;
  callerName: string | null;
  address: Record<string, unknown> | null;
  urgency: Urgency;
  reasons: string[];
  intake: Record<string, unknown>;
  vapiCallId: string | null;
};

export interface DispatchRepository {
  create(input: DispatchInput): Promise<{ id: string }>;
  /** An open dispatch of this urgency already recorded on this call (dedupe). */
  findOpenForCall(vapiCallId: string, urgency: Urgency): Promise<{ id: string } | null>;
  /** open → acknowledged. Null when the request isn't open (already acknowledged, resolved or missing). */
  acknowledge(id: string, at: Date): Promise<{ id: string; status: DispatchStatus } | null>;
  /** open or acknowledged → resolved. Null when already resolved or missing. */
  resolve(id: string, at: Date): Promise<{ id: string; status: DispatchStatus } | null>;
}

export type CallbackInput = {
  callerPhone: string | null;
  callerName: string | null;
  reason: string;
  context: Record<string, unknown>;
  vapiCallId: string | null;
};

export interface CallbackRepository {
  create(input: CallbackInput): Promise<{ id: string }>;
  /** open → done. Null when already done or missing. */
  markDone(id: string, at: Date): Promise<{ id: string; status: CallbackStatus } | null>;
}

export type BookingAddress = {
  id: string;
  line1: string;
  unit: string | null;
  city: string;
  zip: string;
  county: string | null;
  propertyType: "residential" | "commercial";
  accessNotes: string | null;
};

export type ClaimRules = {
  isMember: boolean;
  /** Windows must start at or after this instant. */
  earliestStart: Date;
  /** Non-members can't take the reserved seats of windows starting before this instant. */
  memberPriorityUntil: Date;
  memberReservedSeats: number;
};

/** Operations available inside one booking transaction. */
export interface BookingTx {
  getSlot(slotId: string): Promise<SlotRow | null>;
  findCustomerById(customerId: string): Promise<CustomerRow | null>;
  findCustomerByPhone(phoneE164: string): Promise<CustomerRow | null>;
  /** Insert, or return the existing customer if the phone was taken concurrently. */
  insertCustomer(input: { firstName: string; lastName: string; phoneE164: string; email: string | null }): Promise<CustomerRow>;
  hasActiveMembership(customerId: string): Promise<boolean>;
  findAddresses(customerId: string): Promise<BookingAddress[]>;
  insertAddress(input: Omit<BookingAddress, "id"> & { customerId: string }): Promise<BookingAddress>;
  updateAccessNotes(addressId: string, accessNotes: string): Promise<void>;
  findAppointment(customerId: string, slotId: string): Promise<{ id: string; status: "confirmed" | "cancelled" } | null>;
  /** Atomic: UPDATE ... SET booked = booked + 1 WHERE booked < capacity (minus reserved) RETURNING. */
  claimSeat(slotId: string, rules: ClaimRules): Promise<boolean>;
  insertAppointment(input: {
    slotId: string;
    customerId: string;
    addressId: string;
    serviceType: "maintenance" | "repair" | "diagnostic";
    urgency: Urgency;
    issueSummary: string;
    symptoms: string[];
    intake: Record<string, unknown>;
    technicianNotes: string;
    vapiCallId: string | null;
  }): Promise<{ id: string }>;
}

export interface SchedulingRepository {
  /** Slots in a county starting within [from, to] that still have a free seat, earliest first. */
  findOpenSlots(input: { county: string; from: Date; to: Date }): Promise<SlotRow[]>;
  /** Runs `fn` in one transaction; anything thrown rolls the whole booking back. */
  runBooking<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T>;
  findConfirmedAppointment(customerId: string, slotId: string): Promise<{ id: string } | null>;
}

export interface HealthRepository {
  /** `select 1`: wakes a suspended database and checks the connection. */
  ping(): Promise<void>;
}

export type Repositories = {
  customers: CustomerRepository;
  serviceArea: ServiceAreaRepository;
  toolInvocations: ToolInvocationRepository;
  calls: CallRepository;
  scheduling: SchedulingRepository;
  dispatch: DispatchRepository;
  callbacks: CallbackRepository;
  health: HealthRepository;
};

// ---------------------------------------------------------------------------
// Operations console (M4): read-only queries. Rows are raw; the console services
// in src/server/console/ derive outcomes, urgency order and display text.

export type JsonObject = Record<string, unknown>;

export type BoardDispatchRow = {
  id: string;
  urgency: Urgency;
  reasons: string[];
  status: DispatchStatus;
  callerName: string | null;
  callerPhone: string | null;
  /** Free-form address captured on the call (line1, unit, city, zip, access_notes). */
  address: JsonObject | null;
  intake: JsonObject | null;
  /** Name/phone of the linked customer record, if the caller was verified. */
  customerName: string | null;
  customerPhone: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  vapiCallId: string | null;
  isDemoSeed: boolean;
};

export type BoardCallbackRow = {
  id: string;
  reason: string | null;
  context: JsonObject | null;
  callerName: string | null;
  callerPhone: string | null;
  createdAt: Date;
  vapiCallId: string | null;
  isDemoSeed: boolean;
  /** From the latest successful triage_issue on the same call, if any. */
  triageUrgency: Urgency | null;
  triageReasons: string[];
};

/** One call: an end-of-call report, tool activity, or both. */
export type CallActivityRow = {
  vapiCallId: string;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  callerPhone: string | null;
  summary: string | null;
  hasReport: boolean;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  isDemoSeed: boolean;
};

export type CallDetailRow = CallActivityRow & { transcript: string | null };

export type InvocationRow = {
  id: string;
  vapiCallId: string;
  toolName: string;
  args: JsonObject | null;
  result: JsonObject;
  ok: boolean;
  latencyMs: number;
  dbMs: number | null;
  createdAt: Date;
};

export type CallAppointmentRow = {
  id: string;
  vapiCallId: string;
  status: "confirmed" | "cancelled";
  urgency: Urgency;
  issueSummary: string | null;
  customerName: string;
  customerPhone: string;
  startsAt: Date;
  endsAt: Date;
};

export type CallDispatchRow = {
  id: string;
  vapiCallId: string;
  urgency: Urgency;
  reasons: string[];
  status: DispatchStatus;
  callerName: string | null;
  callerPhone: string | null;
  intake: JsonObject | null;
};

export type CallCallbackRow = {
  id: string;
  vapiCallId: string;
  reason: string | null;
  status: CallbackStatus;
  callerName: string | null;
  callerPhone: string | null;
  context: JsonObject | null;
};

export type CallRecords = {
  invocations: InvocationRow[];
  appointments: CallAppointmentRow[];
  dispatches: CallDispatchRow[];
  callbacks: CallCallbackRow[];
};

export type UpcomingAppointmentRow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  county: string;
  customerName: string;
  customerPhone: string;
  isMember: boolean;
  line1: string;
  unit: string | null;
  city: string;
  zip: string;
  accessNotes: string | null;
  serviceType: "maintenance" | "repair" | "diagnostic";
  urgency: Urgency;
  issueSummary: string | null;
  technicianNotes: string | null;
  vapiCallId: string | null;
  isDemoSeed: boolean;
};

export type OverviewStats = {
  calls: number;
  bookings: number;
  priorityRequests: number;
  openCallbacks: number;
  openDispatches: number;
  toolCalls: number;
  toolErrors: number;
  avgToolMs: number | null;
  p95ToolMs: number | null;
};

export type ActivityKind =
  | "call_ended"
  | "booked"
  | "dispatch_created"
  | "dispatch_acknowledged"
  | "dispatch_resolved"
  | "callback_created"
  | "callback_done";

export type ActivityRow = {
  at: Date;
  kind: ActivityKind;
  refId: string;
  vapiCallId: string | null;
  who: string | null;
  detail: string | null;
  urgency: Urgency | null;
  isDemoSeed: boolean;
};

export interface ConsoleRepository {
  /** Open and acknowledged dispatch requests, and open callbacks. Unsorted. */
  board(opts: { includeSeed: boolean }): Promise<{ dispatches: BoardDispatchRow[]; callbacks: BoardCallbackRow[] }>;
  /** Most recent calls first, by start time (or first tool call while a call is in progress). */
  recentCalls(opts: { includeSeed: boolean; limit: number }): Promise<CallActivityRow[]>;
  call(vapiCallId: string): Promise<CallDetailRow | null>;
  /** Cheap existence check (two index lookups) for the proxy's 404 on unknown call IDs. */
  callExists(vapiCallId: string): Promise<boolean>;
  /** Tool invocations (oldest first) and the records the calls created. */
  callRecords(vapiCallIds: string[]): Promise<CallRecords>;
  /** Confirmed appointments whose window hasn't ended before `from`, earliest first. */
  upcomingAppointments(opts: { includeSeed: boolean; from: Date; limit: number }): Promise<UpcomingAppointmentRow[]>;
  /** Counts for [from, to); open counts are current regardless of the range. */
  overviewStats(opts: { includeSeed: boolean; from: Date; to: Date }): Promise<OverviewStats>;
  recentActivity(opts: { includeSeed: boolean; limit: number }): Promise<ActivityRow[]>;
}
