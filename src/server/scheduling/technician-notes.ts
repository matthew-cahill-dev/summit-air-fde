// Pure: the dispatch-ready paragraph a technician reads before the visit.

export type TechnicianNotesInput = {
  urgency: string;
  serviceType: string;
  customerName: string;
  isMember: boolean;
  phoneE164: string | null;
  address: { line1: string; unit: string | null; city: string; zip: string };
  windowLabel: string;
  issueSummary: string;
  symptoms: string[];
  equipment?: string;
  vulnerableOccupants: string[];
  accessNotes: string | null;
  vapiCallId: string | null;
};

function formatUsPhone(e164: string | null): string | null {
  const m = e164 ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164) : null;
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

export function buildTechnicianNotes(i: TechnicianNotesInput): string {
  const addr = `${i.address.line1}${i.address.unit ? `, Apt ${i.address.unit}` : ""}, ${i.address.city}, NY ${i.address.zip}`;
  const parts = [
    `${i.urgency.toUpperCase()} ${i.serviceType} for ${i.customerName} (${i.isMember ? "active member" : "non-member"}) at ${addr}.`,
    `Arrival window: ${i.windowLabel}.`,
    `Issue: ${sentence(i.issueSummary)}`,
    i.symptoms.length ? `Symptoms: ${i.symptoms.join("; ")}.` : null,
    i.equipment ? `Equipment: ${sentence(i.equipment)}` : null,
    i.vulnerableOccupants.length ? `Vulnerable occupants: ${i.vulnerableOccupants.map((v) => v.replace(/_/g, " ")).join(", ")}.` : null,
    `Access: ${i.accessNotes ? sentence(i.accessNotes) : "none noted."}`,
    `Contact: ${formatUsPhone(i.phoneE164) ?? "not provided"}.`,
    `Booked by the virtual assistant${i.vapiCallId ? ` (call ${i.vapiCallId})` : ""}.`,
  ];
  return parts.filter(Boolean).join(" ");
}
