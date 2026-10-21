// Caller context: who is calling, are they a member, what's on file.
// Used by lookup_customer now; designed to also back a future
// assistant-request endpoint (personalized greeting before answer), which
// has a hard ~7.5 s end-to-end budget, hence the timing and 2-round-trip query.
import { streetAddressMatches } from "@/server/lib/address-match";
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

export type MatchedBy = "phone" | "demo_alias" | "name";

export type CallerContext =
  | { found: false; phoneE164: string }
  | {
      found: true;
      matchedBy: MatchedBy;
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

/**
 * Pure: shape repository rows into caller context.
 * Defense in depth: rows are only accepted if they are the record that was asked for:
 * the same phone, or (demo alias / name match) the expected customer id.
 */
export function buildCallerContext(
  phoneE164: string,
  rows: CallerContextRows | null,
  expect: { matchedBy: "phone" } | { matchedBy: "demo_alias" | "name"; customerId: string } = { matchedBy: "phone" },
): CallerContext {
  if (!rows) return { found: false, phoneE164 };
  const isExpected =
    expect.matchedBy === "phone" ? rows.customer.phoneE164 === phoneE164 : rows.customer.id === expect.customerId;
  if (!isExpected) return { found: false, phoneE164 };

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
    matchedBy: expect.matchedBy,
    phoneE164: expect.matchedBy === "phone" ? phoneE164 : rows.customer.phoneE164,
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

/**
 * Fetch + shape. `phoneE164` must already be normalized. A phone listed in
 * DEMO_CALLER_PHONES resolves to its seeded demo customer instead.
 */
export async function getCallerContext(
  phoneE164: string,
  repo: CustomerRepository,
  demoCallerMap: ReadonlyMap<string, string> = new Map(),
): Promise<{ context: CallerContext; dbMs: number }> {
  const started = performance.now();
  const demoCustomerId = demoCallerMap.get(phoneE164);
  const rows = demoCustomerId
    ? await repo.findCallerContextByCustomerId(demoCustomerId)
    : await repo.findCallerContextByPhone(phoneE164);
  const dbMs = Math.round(performance.now() - started);
  const context = demoCustomerId
    ? buildCallerContext(phoneE164, rows, { matchedBy: "demo_alias", customerId: demoCustomerId })
    : buildCallerContext(phoneE164, rows);
  // A demo alias reports the caller's own number, never the seeded one.
  return { context: context.found && demoCustomerId ? { ...context, phoneE164 } : context, dbMs };
}

export type NameLookup =
  | { status: "unverified" }
  /** needs: what would tell the matches apart (ZIP when it wasn't given, else the account phone). */
  | { status: "ambiguous"; needs: "zip" | "phone" }
  | { status: "verified"; context: Extract<CallerContext, { found: true }> };

/** Keep only the addresses the caller stated; recompute the equipment summary for them. */
export function restrictToAddresses(
  context: Extract<CallerContext, { found: true }>,
  addressIds: ReadonlySet<string>,
): Extract<CallerContext, { found: true }> {
  const addresses = context.addresses.filter((a) => addressIds.has(a.addressId));
  return {
    ...context,
    addresses,
    equipmentSummary:
      addresses.length === 1
        ? addresses[0].equipmentSummary
        : addresses.map((a) => `${a.line1}: ${a.equipmentSummary}`).join("; "),
  };
}

/**
 * Last name + the street address the CALLER states, ZIP optional. The caller is
 * verified only if exactly one customer address matches name and street (and ZIP,
 * if given); the ZIP is then taken from that address. Several matches are
 * "ambiguous" (ask for the ZIP, or the account phone if the ZIP was already given).
 * Not-found and mismatch look identical ("unverified") so the tool can't be used
 * to probe which addresses exist.
 */
export async function verifyCustomerByName(
  input: { lastName: string; zip?: string; streetAddress: string },
  repo: CustomerRepository,
): Promise<NameLookup> {
  const rows = await repo.findByLastName({ lastName: input.lastName, zip: input.zip });
  const matches = rows.filter((r) => streetAddressMatches(input.streetAddress, r.line1));
  const customerIds = [...new Set(matches.map((m) => m.customerId))];
  if (customerIds.length === 0) return { status: "unverified" };
  // Without a ZIP, the same street in two places is ambiguous even for one customer.
  if (!input.zip && new Set(matches.map((m) => m.zip)).size > 1) return { status: "ambiguous", needs: "zip" };
  if (customerIds.length > 1) return { status: "ambiguous", needs: input.zip ? "phone" : "zip" };

  const [customerId] = customerIds;
  const context = buildCallerContext("", await repo.findCallerContextByCustomerId(customerId), { matchedBy: "name", customerId });
  if (!context.found) return { status: "unverified" };
  return { status: "verified", context: restrictToAddresses(context, new Set(matches.map((m) => m.addressId))) };
}
