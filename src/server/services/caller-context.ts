// Caller context: who is calling, are they a member, what's on file.
// Used by lookup_customer now; designed to also back a future
// assistant-request endpoint (personalized greeting before answer), which
// has a hard ~7.5 s end-to-end budget, hence the timing and 2-round-trip query.
import type { CallerContextRows, CustomerRepository, EquipmentRow, MembershipRow } from "@/server/repositories";

export type CallerContextAddress = {
  addressId: string;
  line1: string;
  unit: string | null;
  city: string;
  zip: string;
  county: string | null;
  propertyType: "residential" | "commercial";
  accessNotes: string | null;
  equipmentSummary: string;
};

export type CallerContext =
  | { found: false; phoneE164: string }
  | {
      found: true;
      phoneE164: string;
      customerId: string;
      firstName: string;
      lastName: string;
      membership: { status: "active" | "lapsed"; planName: string; renewsOn: string } | null;
      isActiveMember: boolean;
      addresses: CallerContextAddress[];
      /** One line covering all addresses, suitable for the agent to read. */
      equipmentSummary: string;
    };

const EQUIPMENT_LABELS: Record<EquipmentRow["kind"], string> = {
  furnace: "furnace",
  boiler: "boiler",
  central_ac: "central AC",
  heat_pump: "heat pump",
  mini_split: "ductless mini-split",
  other: "other equipment",
};

export function describeEquipment(items: EquipmentRow[]): string {
  if (items.length === 0) return "no equipment on file";
  return items
    .map((e) => {
      const details = [e.brand && e.brand !== "Unknown" ? e.brand : null, e.installYear ? String(e.installYear) : null]
        .filter(Boolean)
        .join(", ");
      return details ? `${EQUIPMENT_LABELS[e.kind]} (${details})` : EQUIPMENT_LABELS[e.kind];
    })
    .join(", ");
}

/** Prefer an active membership; otherwise the most recently renewing one. */
export function pickMembership(rows: MembershipRow[]): MembershipRow | null {
  if (rows.length === 0) return null;
  const active = rows.filter((m) => m.status === "active");
  const pool = active.length ? active : rows;
  return [...pool].sort((a, b) => (a.renewsOn < b.renewsOn ? 1 : a.renewsOn > b.renewsOn ? -1 : 0))[0];
}

/** Pure: shape repository rows into caller context. */
export function buildCallerContext(phoneE164: string, rows: CallerContextRows | null): CallerContext {
  // Defense in depth: never return a record for a different number than asked.
  if (!rows || rows.customer.phoneE164 !== phoneE164) return { found: false, phoneE164 };

  const membership = pickMembership(rows.memberships);
  const addresses: CallerContextAddress[] = rows.addresses.map((a) => ({
    addressId: a.id,
    line1: a.line1,
    unit: a.unit,
    city: a.city,
    zip: a.zip,
    county: a.county,
    propertyType: a.propertyType,
    accessNotes: a.accessNotes,
    equipmentSummary: describeEquipment(a.equipment),
  }));

  const equipmentSummary =
    addresses.length === 0
      ? "no equipment on file"
      : addresses.length === 1
        ? addresses[0].equipmentSummary
        : addresses.map((a) => `${a.line1}: ${a.equipmentSummary}`).join("; ");

  return {
    found: true,
    phoneE164,
    customerId: rows.customer.id,
    firstName: rows.customer.firstName,
    lastName: rows.customer.lastName,
    membership: membership
      ? { status: membership.status, planName: membership.planName, renewsOn: membership.renewsOn }
      : null,
    isActiveMember: membership?.status === "active",
    addresses,
    equipmentSummary,
  };
}

/** Fetch + shape. `phoneE164` must already be normalized. */
export async function getCallerContext(
  phoneE164: string,
  repo: CustomerRepository,
): Promise<{ context: CallerContext; dbMs: number }> {
  const started = performance.now();
  const rows = await repo.findCallerContextByPhone(phoneE164);
  const dbMs = Math.round(performance.now() - started);
  return { context: buildCallerContext(phoneE164, rows), dbMs };
}
