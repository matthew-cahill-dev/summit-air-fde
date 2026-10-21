// Technician intake: what a technician needs before the visit, gathered on the call.
// Shared by book_appointment and create_priority_dispatch so both carry the same
// fields; stored in the existing `intake` jsonb (no migration) and rendered into notes.
import { z } from "zod";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import type { IntakeDetails } from "@/server/scheduling/technician-notes";

const text = () => optionalArg(z.string().trim().min(1));

/** {} or an object with no name counts as omitted: models send empty objects for fields they don't have. */
function blankContactToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name;
    if (name === undefined || name === null || (typeof name === "string" && name.trim() === "")) return undefined;
  }
  return value;
}

export const onSiteContactSchema = z.object({
  name: z.string().trim().min(1),
  phone: text(),
  relationship: text(),
});

export const technicianIntakeShape = {
  onset: text(),
  equipment: text(),
  tried_steps: z.array(z.string().trim().min(1)).default([]),
  error_code: text(),
  pets: text(),
  on_site_contact: z.preprocess(blankContactToUndefined, onSiteContactSchema.optional()).optional(),
};

export type TechnicianIntake = {
  onset?: string;
  equipment?: string;
  tried_steps: string[];
  error_code?: string;
  pets?: string;
  on_site_contact?: z.infer<typeof onSiteContactSchema>;
};

/** The intake fields as stored in jsonb: explicit nulls, on-site phone normalized when it parses. */
export function intakeRecord(i: TechnicianIntake) {
  const contact = i.on_site_contact;
  return {
    onset: i.onset ?? null,
    equipment: i.equipment ?? null,
    tried_steps: i.tried_steps,
    error_code: i.error_code ?? null,
    pets: i.pets ?? null,
    on_site_contact: contact
      ? {
          name: contact.name,
          phone: contact.phone ? (normalizePhoneE164(contact.phone) ?? contact.phone) : null,
          relationship: contact.relationship ?? null,
        }
      : null,
  };
}

/** The same intake in the shape the notes renderer takes. */
export function intakeDetails(i: TechnicianIntake): IntakeDetails {
  const r = intakeRecord(i);
  return {
    onset: r.onset,
    equipment: r.equipment,
    triedSteps: r.tried_steps,
    errorCode: r.error_code,
    pets: r.pets,
    onSiteContact: r.on_site_contact,
  };
}
