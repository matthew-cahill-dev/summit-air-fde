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

/**
 * Stored failures a later identical call may replace instead of replaying: a transient error, and
 * lookup_required (triage/booking refused until lookup_customer ran; the same arguments succeed after).
 */
export const RETRYABLE_ERROR_CODES = ["internal_error", "lookup_required"] as const;

export interface ToolInvocationRepository {
  findByKey(key: string): Promise<StoredInvocation | null>;
  /**
   * Insert the invocation. If the key already exists, only a prior retryable
   * failure (RETRYABLE_ERROR_CODES) is overwritten. Returns the row that
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
    /** From a simulation, web call or chat, not a real phone call. */
    isSimulation?: boolean;
  }): Promise<StoredInvocation>;
  /** Failed identity checks so far on this call (results with verification_failed: true). */
  countFailedVerifications(vapiCallId: string): Promise<number>;
  /** Arguments of the latest successful call of `toolName` on this call (e.g. triage_issue), or null. */
  latestOkArgs(vapiCallId: string, toolName: string): Promise<Record<string, unknown> | null>;
  /** Whether `toolName` was invoked at all on this call (any outcome). */
  wasInvoked(vapiCallId: string, toolName: string): Promise<boolean>;
  /** Results of every successful call of `toolName` on this call, oldest first. */
  okResults(vapiCallId: string, toolName: string): Promise<Record<string, unknown>[]>;
}

export type EndOfCallReport = {
  vapiCallId: string;
  /** Caller stop → assistant start (ms), from the report's messages; null when not computable. */
  responseP50Ms?: number | null;
  responseP95Ms?: number | null;
  responseTurns?: number | null;
  callerPhone: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  rawReport: unknown;
  /** Not a real phone call (see isSimulationMessage). */
  isSimulation?: boolean;
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
  /**
   * The call's one safety-stop/emergency record, under a per-call lock so concurrent tool calls
   * and the hang-up check never duplicate it. Missing: created from `input`. Present: "merge" adds
   * the new details (blanks never overwrite; reasons combine; safety stop outranks emergency),
   * "keep" leaves it as it is. Without a call id, always creates.
   */
  ensureForCall(input: DispatchInput, mode: "merge" | "keep"): Promise<{ id: string; created: boolean }>;
  /** An open dispatch of this urgency already recorded on this call (dedupe). */
  findOpenForCall(vapiCallId: string, urgency: Urgency): Promise<{ id: string } | null>;
  /** Any safety-stop or emergency dispatch on this call, in any status (post-call reconciliation). */
  findSafetyOrEmergencyForCall(vapiCallId: string): Promise<{ id: string } | null>;
  /** open → acknowledged ("Called back"). Null when the request isn't open (already called back, resolved or missing). */
  acknowledge(id: string, at: Date, by?: string | null): Promise<{ id: string; status: DispatchStatus } | null>;
  /** Undo: acknowledged → open. */
  unacknowledge(id: string): Promise<{ id: string; status: DispatchStatus } | null>;
  /** open or acknowledged → resolved, with an outcome. Null when already resolved or missing. */
  resolve(id: string, at: Date, detail?: ResolutionDetail): Promise<{ id: string; status: DispatchStatus } | null>;
  /** Undo: resolved → back to called back (if it was) or open. */
  unresolve(id: string): Promise<{ id: string; status: DispatchStatus } | null>;
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
  /**
   * One open callback per call: insert, or (if this call already has an open one) let
   * `merge` turn the stored row into the new values and update it in place. Serialized per
   * call with an advisory lock, so two concurrent requests can't both insert.
   */
  upsertOpenForCall(
    input: CallbackInput & { vapiCallId: string },
    merge: (existing: { reason: string | null; callerName: string | null; callerPhone: string | null; context: Record<string, unknown> }) => Omit<CallbackInput, "vapiCallId">,
  ): Promise<{ id: string; updated: boolean }>;
  /** open → done ("Resolved"), with an outcome. Null when already done or missing. */
  markDone(id: string, at: Date, detail?: ResolutionDetail): Promise<{ id: string; status: CallbackStatus } | null>;
  /** Undo: done → open (keeps "called back" if it was). */
  reopen(id: string): Promise<{ id: string; status: CallbackStatus } | null>;
  /** "Called back": stops the callback SLA. Null when not open or already called back. */
  markCalledBack(id: string, at: Date, by?: string | null): Promise<{ id: string; status: CallbackStatus } | null>;
  /** Undo of called back. */
  unmarkCalledBack(id: string): Promise<{ id: string; status: CallbackStatus } | null>;
}

export type ResolutionDetail = { resolution: string; note?: string | null; by?: string | null };

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
  findAppointment(
    customerId: string,
    slotId: string,
  ): Promise<{ id: string; status: "confirmed" | "cancelled"; intake: Record<string, unknown> | null } | null>;
  /** A detail added after booking (e.g. an arrival preference): new intake and technician notes, same appointment. */
  updateAppointmentDetails(id: string, input: { intake: Record<string, unknown>; technicianNotes: string }): Promise<void>;
  /** Serializes bookings within one call (transaction-scoped advisory lock on the call id). */
  lockCall(vapiCallId: string): Promise<void>;
  /** This call's confirmed appointment, if it booked one (one active appointment per call). */
  findCallAppointment(vapiCallId: string): Promise<{ id: string; slotId: string; intake: Record<string, unknown> | null } | null>;
  /** Gives a seat back (a window changed during the call). Never below zero. */
  releaseSeat(slotId: string): Promise<void>;
  /** Rewrites an appointment in place (new window and details), confirmed. Used to move or revive one. */
  replaceAppointment(id: string, input: AppointmentInput): Promise<void>;
  cancelAppointment(id: string): Promise<void>;
  /** Locks one appointment row for a console change (status, cancel, reschedule). */
  lockAppointment(id: string): Promise<LockedAppointment | null>;
  /** Console lifecycle fields; only the keys given change. */
  setAppointmentLifecycle(id: string, patch: AppointmentLifecyclePatch): Promise<void>;
  /** Removes an appointment row (only used to undo a console reschedule within seconds). */
  deleteAppointment(id: string): Promise<void>;
  /** Atomic: UPDATE ... SET booked = booked + 1 WHERE booked < capacity (minus reserved) RETURNING. */
  claimSeat(slotId: string, rules: ClaimRules): Promise<boolean>;
  insertAppointment(input: AppointmentInput): Promise<{ id: string }>;
}

export type AppointmentInput = {
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
  /** Console reschedule: the appointment this one replaces. */
  rescheduledFrom?: string | null;
  isDemoSeed?: boolean;
};

export type LockedAppointment = AppointmentInput & {
  id: string;
  status: "confirmed" | "cancelled";
  completion: string | null;
  isDemoSeed: boolean;
  rescheduledFrom: string | null;
};

export type AppointmentLifecyclePatch = Partial<{
  status: "confirmed" | "cancelled";
  completion: "completed" | "no_show" | null;
  completedAt: Date | null;
  completionNote: string | null;
  cancelledAt: Date | null;
  statusBy: string | null;
}>;

export interface SchedulingRepository {
  /** Slots in a county starting within [from, to] that still have a free seat, earliest first. */
  findOpenSlots(input: { county: string; from: Date; to: Date }): Promise<SlotRow[]>;
  /** Runs `fn` in one transaction; anything thrown rolls the whole booking back. */
  runBooking<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T>;
  findConfirmedAppointment(customerId: string, slotId: string): Promise<{ id: string } | null>;
  /** Whether this call already booked a (confirmed) appointment. */
  hasConfirmedAppointmentForCall(vapiCallId: string): Promise<boolean>;
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

/** What the console shows: seed data and test traffic (simulations, web calls) are opt-in. */
export type Scope = { includeSeed: boolean; includeTests?: boolean };

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
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
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
  status: CallbackStatus;
  calledBackAt: Date | null;
  calledBackBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  vapiCallId: string | null;
  isDemoSeed: boolean;
  /** From the latest successful triage_issue on the same call, if any. */
  triageUrgency: Urgency | null;
  triageReasons: string[];
  triageArgs: JsonObject | null;
  /** The caller's next scheduled appointment (by verified account or phone), for reschedule/cancel callbacks. */
  appointmentId: string | null;
};

/** One call: an end-of-call report, tool activity, or both. */
export type CallActivityRow = {
  vapiCallId: string;
  /** Caller stop → assistant start median, from the end-of-call report (null before it arrives). */
  responseP50Ms?: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  callerPhone: string | null;
  summary: string | null;
  hasReport: boolean;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  isDemoSeed: boolean;
  /** A simulation, web call or chat, not a real phone call. */
  isSimulation?: boolean;
};

export type CallDetailRow = CallActivityRow & {
  transcript: string | null;
  /** Caller stop → assistant start, from the end-of-call report. */
  responseP50Ms: number | null;
  responseP95Ms: number | null;
  responseTurns: number | null;
};

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
  createdAt?: Date;
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  resolvedAt?: Date | null;
  resolution?: string | null;
  resolutionNote?: string | null;
  resolvedBy?: string | null;
};

export type CallCallbackRow = {
  id: string;
  vapiCallId: string;
  reason: string | null;
  status: CallbackStatus;
  callerName: string | null;
  callerPhone: string | null;
  context: JsonObject | null;
  createdAt?: Date;
  calledBackAt?: Date | null;
  calledBackBy?: string | null;
  resolvedAt?: Date | null;
  resolution?: string | null;
  resolutionNote?: string | null;
  resolvedBy?: string | null;
};

export type CallRecords = {
  invocations: InvocationRow[];
  appointments: CallAppointmentRow[];
  dispatches: CallDispatchRow[];
  callbacks: CallCallbackRow[];
};

/** The console's appointment lifecycle, derived from status + completion (no enum change). */
export type AppointmentStage = "scheduled" | "completed" | "cancelled" | "no_show";

export type AppointmentRow = {
  id: string;
  stage: AppointmentStage;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  county: string;
  customerId: string;
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
  /** "around 8:30 AM": the caller's preferred arrival inside the window, when they gave one. */
  arrivalPreference: string | null;
  vapiCallId: string | null;
  isDemoSeed: boolean;
  createdAt: Date;
  completedAt: Date | null;
  completionNote: string | null;
  cancelledAt: Date | null;
  statusBy: string | null;
  rescheduledFrom: string | null;
  /** The appointment that replaced this one, when it was rescheduled. */
  rescheduledTo: string | null;
};

/** @deprecated kept for older call sites; same as AppointmentRow. */
export type UpcomingAppointmentRow = AppointmentRow;

/** One tool call, for system health (real errors vs guardrail refusals, latency). */
export type ToolHealthRow = { toolName: string; ok: boolean; errorCode: string | null; latencyMs: number; createdAt: Date };

export type ActivityKind =
  | "call_ended"
  | "booked"
  | "dispatch_created"
  | "dispatch_acknowledged"
  | "dispatch_resolved"
  | "callback_created"
  | "callback_called_back"
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
  /** Open and called-back dispatches and callbacks; plus those resolved since `resolvedSince`. Unsorted. */
  board(opts: Scope & { resolvedSince?: Date }): Promise<{ dispatches: BoardDispatchRow[]; callbacks: BoardCallbackRow[] }>;
  /** Most recent calls first, by call time (start, else first tool call, else end); optionally only since `since`. */
  recentCalls(opts: Scope & { limit: number; since?: Date }): Promise<CallActivityRow[]>;
  call(vapiCallId: string): Promise<CallDetailRow | null>;
  /** Cheap existence check (two index lookups) for the proxy's 404 on unknown call IDs. */
  callExists(vapiCallId: string): Promise<boolean>;
  /** Tool invocations (oldest first) and the records the calls created. */
  callRecords(vapiCallIds: string[]): Promise<CallRecords>;
  /**
   * Appointments: by default scheduled ones whose window hasn't ended before `from`; `closedSince`
   * adds completed / cancelled / no-show changed since then; `bookedSince` returns only those booked
   * since then (original bookings, not reschedules); `ids` returns exactly those.
   */
  appointments(opts: Scope & { from?: Date; closedSince?: Date; bookedSince?: Date; ids?: string[]; limit: number }): Promise<AppointmentRow[]>;
  /** Tool calls since `from` (real traffic unless includeTests). */
  toolHealthRows(opts: Scope & { from: Date }): Promise<ToolHealthRow[]>;
  recentActivity(opts: Scope & { limit: number }): Promise<ActivityRow[]>;
  /** Caller and Ava lines with timestamps, from the stored end-of-call report (empty before it arrives). */
  callMessages(vapiCallId: string): Promise<TranscriptMessage[]>;
}

export type TranscriptMessage = { role: "caller" | "ava"; text: string; at: Date };
