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

export type Repositories = {
  customers: CustomerRepository;
  serviceArea: ServiceAreaRepository;
  toolInvocations: ToolInvocationRepository;
  calls: CallRepository;
};
