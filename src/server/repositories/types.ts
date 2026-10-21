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

export type Repositories = {
  customers: CustomerRepository;
  serviceArea: ServiceAreaRepository;
  toolInvocations: ToolInvocationRepository;
  calls: CallRepository;
  scheduling: SchedulingRepository;
  dispatch: DispatchRepository;
  callbacks: CallbackRepository;
};
