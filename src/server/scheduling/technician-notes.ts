// Pure: the dispatch-ready paragraph a technician reads before the visit.
import { normalizePhoneE164 } from "@/server/lib/phone";
import type { PropertyKind } from "@/server/triage/property";

export type OnSiteContact = { name: string; phone: string | null; relationship: string | null };

/** The technician intake gathered on the call (book_appointment and create_priority_dispatch). */
export type IntakeDetails = {
  onset?: string | null;
  symptoms?: string[];
  equipment?: string | null;
  triedSteps?: string[];
  errorCode?: string | null;
  vulnerableOccupants?: string[];
  pets?: string | null;
  onSiteContact?: OnSiteContact | null;
};

export type TechnicianNotesInput = IntakeDetails & {
  /** From the call's triage; the notes open with it. Null/absent = residential (the address on file). */
  property?: PropertyKind | null;
  urgency: string;
  serviceType: string;
  customerName: string;
  isMember: boolean;
  phoneE164: string | null;
  address: { line1: string; unit: string | null; city: string; zip: string };
  windowLabel: string;
  issueSummary: string;
  accessNotes: string | null;
  vapiCallId: string | null;
};

export function formatUsPhone(e164: string | null): string | null {
  const m = e164 ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164) : null;
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** "Rosa Alvarez (caller's mother), (718) 555-0199" */
export function describeContact(c: OnSiteContact): string {
  const phone = c.phone ? formatUsPhone(normalizePhoneE164(c.phone) ?? c.phone) : null;
  return [`${c.name}${c.relationship ? ` (${c.relationship})` : ""}`, phone].filter(Boolean).join(", ");
}

const PROPERTY_SENTENCE: Record<PropertyKind, string> = {
  residential: "Property: Residential.",
  commercial: "Property: Commercial.",
  multi_unit: "Property: Multi-unit building (central system).",
};

/** The opening sentence of every technician paragraph. */
export function propertySentence(kind: PropertyKind | null | undefined): string {
  return PROPERTY_SENTENCE[kind ?? "residential"];
}

/** The intake as sentences, in the order a technician uses them. Absent fields are left out. */
export function intakeSentences(i: IntakeDetails): string[] {
  return [
    i.onset ? `Started: ${sentence(i.onset)}` : null,
    i.symptoms?.length ? `Symptoms: ${i.symptoms.join("; ")}.` : null,
    i.equipment ? `Equipment: ${sentence(i.equipment)}` : null,
    i.triedSteps?.length ? `Already tried: ${i.triedSteps.join("; ")}.` : null,
    i.errorCode ? `Error code: ${sentence(i.errorCode)}` : null,
    i.vulnerableOccupants?.length
      ? `Vulnerable occupants: ${i.vulnerableOccupants.map((v) => v.replace(/_/g, " ")).join(", ")}.`
      : null,
    i.pets ? `Pets: ${sentence(i.pets)}` : null,
    i.onSiteContact ? `On-site contact: ${describeContact(i.onSiteContact)}.` : null,
  ].filter((s): s is string => s !== null);
}

export function buildTechnicianNotes(i: TechnicianNotesInput): string {
  const addr = `${i.address.line1}${i.address.unit ? `, Apt ${i.address.unit}` : ""}, ${i.address.city}, NY ${i.address.zip}`;
  const parts = [
    propertySentence(i.property),
    `${i.urgency.toUpperCase()} ${i.serviceType} for ${i.customerName} (${i.isMember ? "active member" : "non-member"}) at ${addr}.`,
    `Arrival window: ${i.windowLabel}.`,
    `Issue: ${sentence(i.issueSummary)}`,
    ...intakeSentences(i),
    `Access: ${i.accessNotes ? sentence(i.accessNotes) : "none noted."}`,
    `${i.onSiteContact ? "Caller" : "Contact"}: ${formatUsPhone(i.phoneE164) ?? "not provided"}.`,
    `Booked by the virtual assistant${i.vapiCallId ? ` (call ${i.vapiCallId})` : ""}.`,
  ];
  return parts.join(" ");
}
