import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { spokenWindow } from "@/server/lib/time";
import type { BookingAddress, CustomerRow } from "@/server/repositories";
import { earliestBookableStart } from "@/server/scheduling/availability";
import { buildTechnicianNotes, type OnSiteContact } from "@/server/scheduling/technician-notes";
import { propertyKind } from "@/server/triage/property";
import { VULNERABLE_OCCUPANTS } from "@/server/triage/rules";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";
import { intakeRecord, technicianIntakeShape } from "./intake";
import { zipSchema } from "./triage-issue";

export const bookAppointmentSchema = z
  .object({
    slot_id: z.uuid(),
    caller_confirmed: z.literal(true, { error: "must be true: read back the booking and get the caller's yes first" }),
    customer_id: optionalArg(z.uuid()),
    // With customer_id (a verified caller), name and phone come from the account; they're
    // only needed to create a new customer, which the handler checks.
    first_name: optionalArg(z.string().trim().min(1)),
    last_name: optionalArg(z.string().trim().min(1)),
    phone: optionalArg(z.string().trim().min(1)),
    email: optionalArg(z.email()),
    address_id: optionalArg(z.uuid()),
    address: optionalArg(
      z.object({
        line1: z.string().trim().min(3),
        unit: optionalArg(z.string().trim().min(1)),
        city: optionalArg(z.string().trim().min(1)),
        zip: zipSchema,
      }),
    ),
    service_type: z.enum(["maintenance", "repair", "diagnostic"]),
    urgency: z.enum(["urgent", "routine"]),
    issue_summary: z.string().trim().min(3),
    symptoms: z.array(z.string().trim().min(1)).default([]),
    ...technicianIntakeShape,
    access_notes: optionalArg(z.string().trim().min(1)),
    vulnerable_occupants: z.array(z.enum(VULNERABLE_OCCUPANTS)).default([]),
    // "Can they come at 8:30?": a preference noted for the technician, never a promise or a callback.
    arrival_preference: optionalArg(z.string().trim().min(1)),
  })
  .superRefine((v, ctx) => {
    if (!v.address_id && !v.address) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "address (or address_id from lookup_customer) is required" });
    }
  });

type BookArgs = z.infer<typeof bookAppointmentSchema>;

/** Expected booking outcomes that roll the transaction back. */
class BookingRejected extends Error {
  constructor(
    readonly code:
      | "slot_taken"
      | "slot_not_found"
      | "customer_not_found"
      | "address_not_found"
      | "slot_wrong_area"
      | "residential_only"
      | "missing_name",
    readonly county: string | null = null,
  ) {
    super(code);
  }
}

/** "37-12 82nd St." / "37-12 82ND STREET" → "37-12 82nd st" for de-duplication. */
export function normalizeLine1(line1: string): string {
  return line1
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\s+/g, " ")
    .trim();
}

const normUnit = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/^(apt|apartment|unit|#)\s*/, "").replace(/\s+/g, "");

/**
 * Comfort Club is mentioned once, after the booking, only to non-members booking routine
 * maintenance with nobody vulnerable at home. Never on urgent, emergency or safety calls.
 */
export function shouldOfferMembership(i: { isMember: boolean; urgency: string; serviceType: string; vulnerableOccupants: string[] }): boolean {
  return !i.isMember && i.urgency === "routine" && i.serviceType === "maintenance" && i.vulnerableOccupants.length === 0;
}

const MEMBERSHIP_SAY =
  ` After the recap, and only once: mention in one sentence that ${BUSINESS.facts.membershipPitch} Ask if they'd like the office to follow up about it. ` +
  "If yes, call create_callback_request with reason other and details 'Interested in Comfort Club membership'. If no, drop it.";

/**
 * A repeat book_appointment for a window the caller already holds adds details instead of
 * replacing them: new non-empty values win, lists are combined, and blanks keep what's stored.
 */
export function mergeIntake(prev: Record<string, unknown> | null, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) {
    const blank = v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    if (blank) continue;
    const before = out[k];
    out[k] = Array.isArray(v) && Array.isArray(before) ? [...new Map([...before, ...v].map((x) => [JSON.stringify(x), x])).values()] : v;
  }
  return out;
}

const strOr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const confirmationCode = (appointmentId: string) => `SA-${appointmentId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function alternatives(ctx: ToolContext, args: BookArgs, county: string, customerId: string | undefined) {
  const selection = await findOfferableSlots(ctx.repos, {
    county,
    urgency: args.urgency,
    isMember: await isActiveMember(ctx.repos, customerId),
    excludeSlotId: args.slot_id,
    now: ctx.now,
    timeZone: ctx.settings.timeZone,
  });
  return selection.slots;
}

export const bookAppointmentTool = defineTool({
  schema: bookAppointmentSchema,
  async handler(args, ctx): Promise<ToolOutcome> {
    const rawPhone = args.phone ?? ctx.callerPhone;
    const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : null;
    if (args.phone && !phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Invalid: phone (not a valid phone number)",
        say: "Ask for the best callback number again, including area code.",
        data: { invalid_fields: [{ field: "phone", problem: "not a valid phone number" }] },
      };
    }
    const customerId = args.customer_id ?? (phoneE164 ? ctx.settings.demoCallerMap.get(phoneE164) : undefined);
    if (!customerId && !phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Missing: phone",
        say: "Ask for the best callback number for the appointment.",
        data: { invalid_fields: [{ field: "phone", problem: "required" }] },
      };
    }

    // New address: check the ZIP up front (outside the transaction).
    let newAddressCounty: string | null = null;
    if (!args.address_id && args.address) {
      const zipRow = await ctx.repos.serviceArea.findZip(args.address.zip);
      if (!zipRow?.active) {
        return {
          ok: false,
          errorCode: "out_of_area",
          message: `ZIP ${args.address.zip} is outside the service area`,
          say: `Confirm the ZIP. If it's right, explain we only serve ${BUSINESS.facts.serviceArea}.`,
        };
      }
      newAddressCounty = zipRow.county;
    }

    // Residential unless this call's triage said otherwise (it opens the technician notes).
    const property = (ctx.callId ? propertyKind(await ctx.repos.toolInvocations.latestOkArgs(ctx.callId, "triage_issue")) : null) ?? "residential";

    const cfg = BUSINESS.scheduling;
    let newCustomer = false;
    let slotCounty: string | null = null;
    let resolvedCustomerId: string | undefined = customerId;

    try {
      const booked = await ctx.repos.scheduling.runBooking(async (tx) => {
        const slot = await tx.getSlot(args.slot_id);
        if (!slot) throw new BookingRejected("slot_not_found");
        slotCounty = slot.county;

        // Customer: explicit id (from lookup or demo alias) or upsert by phone.
        let customer: CustomerRow | null;
        if (customerId) {
          customer = await tx.findCustomerById(customerId);
          if (!customer) throw new BookingRejected("customer_not_found");
        } else {
          customer = await tx.findCustomerByPhone(phoneE164!);
          if (!customer) {
            if (!args.first_name || !args.last_name) throw new BookingRejected("missing_name");
            customer = await tx.insertCustomer({
              firstName: args.first_name,
              lastName: args.last_name,
              phoneE164: phoneE164!,
              email: args.email ?? null,
            });
            newCustomer = true;
          }
        }
        resolvedCustomerId = customer.id;

        // Address: on file by id, matched by normalized street/unit/ZIP, or new.
        const onFile = await tx.findAddresses(customer.id);
        let address: BookingAddress | undefined;
        if (args.address_id) {
          address = onFile.find((a) => a.id === args.address_id);
          if (!address) throw new BookingRejected("address_not_found");
        } else {
          const a = args.address!;
          address =
            onFile.find(
              (o) => o.zip === a.zip && normalizeLine1(o.line1) === normalizeLine1(a.line1) && normUnit(o.unit) === normUnit(a.unit),
            ) ??
            (await tx.insertAddress({
              customerId: customer.id,
              line1: a.line1,
              unit: a.unit ?? null,
              city: a.city ?? "",
              zip: a.zip,
              county: newAddressCounty,
              propertyType: "residential",
              accessNotes: args.access_notes ?? null,
            }));
        }
        if (address.propertyType === "commercial" && BUSINESS.residentialOnly) throw new BookingRejected("residential_only");
        if (address.county !== slot.county) throw new BookingRejected("slot_wrong_area", address.county);
        if (args.access_notes && args.access_notes !== address.accessNotes) {
          await tx.updateAccessNotes(address.id, args.access_notes);
          address = { ...address, accessNotes: args.access_notes };
        }

        const isMember = await tx.hasActiveMembership(customer.id);
        const newIntake: Record<string, unknown> = {
          property_kind: property,
          issue_summary: args.issue_summary,
          symptoms: args.symptoms,
          ...intakeRecord(args),
          vulnerable_occupants: args.vulnerable_occupants,
          access_notes: address.accessNotes,
          arrival_preference: args.arrival_preference ?? null,
          caller_confirmed: true,
        };
        const notesFor = (intake: Record<string, unknown>) =>
          buildTechnicianNotes({
            property,
            urgency: args.urgency,
            serviceType: args.service_type,
            customerName: `${customer.firstName} ${customer.lastName}`,
            isMember,
            phoneE164: phoneE164 ?? customer.phoneE164,
            address,
            windowLabel: spokenWindow(slot.startsAt, slot.endsAt, ctx.settings.timeZone),
            issueSummary: strOr(intake.issue_summary) ?? args.issue_summary,
            symptoms: strList(intake.symptoms),
            onset: strOr(intake.onset),
            equipment: strOr(intake.equipment),
            triedSteps: strList(intake.tried_steps),
            errorCode: strOr(intake.error_code),
            pets: strOr(intake.pets),
            onSiteContact: (intake.on_site_contact as OnSiteContact | null) ?? null,
            vulnerableOccupants: strList(intake.vulnerable_occupants),
            arrivalPreference: strOr(intake.arrival_preference),
            accessNotes: address.accessNotes,
            vapiCallId: ctx.callId,
          });

        // Same customer, same window: no second booking. Details added since (an arrival
        // preference, pets, a code) update this appointment's notes instead of needing a callback.
        const existing = await tx.findAppointment(customer.id, slot.id);
        if (existing?.status === "confirmed") {
          const merged = mergeIntake(existing.intake, newIntake);
          const changed = JSON.stringify(merged) !== JSON.stringify(existing.intake ?? {});
          if (changed) await tx.updateAppointmentDetails(existing.id, { intake: merged, technicianNotes: notesFor(merged) });
          return { appointmentId: existing.id, already: true, detailsUpdated: changed, slot, address, customer, isMember };
        }

        const claimed = await tx.claimSeat(slot.id, {
          isMember,
          earliestStart: earliestBookableStart(ctx.now, cfg),
          memberPriorityUntil: new Date(ctx.now.getTime() + cfg.memberPriorityWindowHours * 3_600_000),
          memberReservedSeats: cfg.memberReservedSeatsPerSlot,
        });
        if (!claimed) throw new BookingRejected("slot_taken", slot.county);

        const appt = await tx.insertAppointment({
          slotId: slot.id,
          customerId: customer.id,
          addressId: address.id,
          serviceType: args.service_type,
          urgency: args.urgency,
          issueSummary: args.issue_summary,
          symptoms: args.symptoms,
          intake: newIntake,
          technicianNotes: notesFor(newIntake),
          vapiCallId: ctx.callId,
        });
        return { appointmentId: appt.id, already: false, detailsUpdated: false, slot, address, customer, isMember };
      });

      const window = spokenWindow(booked.slot.startsAt, booked.slot.endsAt, ctx.settings.timeZone, ctx.now);
      logEvent("appointment_booked", { callId: ctx.callId, already: booked.already, newCustomer });
      // A replay (already) never re-offers: the caller heard it the first time.
      const offerMembership =
        !booked.already &&
        shouldOfferMembership({
          isMember: booked.isMember,
          urgency: args.urgency,
          serviceType: args.service_type,
          vulnerableOccupants: args.vulnerable_occupants,
        });
      return {
        ok: true,
        data: {
          booked: true,
          already_booked: booked.already,
          new_customer: newCustomer && !booked.already,
          appointment_id: booked.appointmentId,
          confirmation_code: confirmationCode(booked.appointmentId),
          customer_id: booked.customer.id,
          window,
          address: { line1: booked.address.line1, unit: booked.address.unit, zip: booked.address.zip },
          offer_membership: offerMembership,
          details_updated: booked.detailsUpdated,
        },
        say: booked.detailsUpdated
          ? "Same booking, no second appointment: the new detail is now in the technician's notes. Say so in one short sentence (e.g. you've noted they'd like around eight thirty, though it's a window). No callback is needed for this."
          : `The booking is confirmed. Recap it in one short sentence: ${window}, at ${booked.address.line1}${booked.address.unit ? `, unit ${booked.address.unit}` : ""}.` +
            (offerMembership ? MEMBERSHIP_SAY : "") +
            " Then ask if there's anything else.",
      };
    } catch (err) {
      if (err instanceof BookingRejected) return rejected(err, args, ctx, slotCounty, resolvedCustomerId);
      if (isUniqueViolation(err) && resolvedCustomerId) {
        // A concurrent duplicate of this same booking won; report that booking.
        const existing = await ctx.repos.scheduling.findConfirmedAppointment(resolvedCustomerId, args.slot_id);
        if (existing) {
          return {
            ok: true,
            data: { booked: true, already_booked: true, appointment_id: existing.id, confirmation_code: confirmationCode(existing.id) },
            say: "The booking is confirmed. Recap the window and address.",
          };
        }
      }
      throw err; // dispatcher turns this into internal_error
    }
  },
});

async function rejected(
  err: BookingRejected,
  args: BookArgs,
  ctx: ToolContext,
  slotCounty: string | null,
  customerId: string | undefined,
): Promise<ToolOutcome> {
  switch (err.code) {
    case "slot_taken": {
      const alts = await alternatives(ctx, args, err.county ?? slotCounty!, customerId);
      return {
        ok: false,
        errorCode: "slot_taken",
        message: "That arrival window was just taken.",
        data: { reason: "slot_taken", alternatives: alts },
        say: alts.length
          ? "Apologize: that window was just taken. Offer these alternatives, then confirm again before booking."
          : "Apologize: that window was just taken and nothing else is open. Offer a callback from the office with create_callback_request.",
      };
    }
    case "slot_wrong_area":
      return {
        ok: false,
        errorCode: "slot_wrong_area",
        message: "That window is for a different borough than the service address.",
        say: "Get availability again for the caller's ZIP code and offer those windows.",
        data: { reason: "slot_wrong_area" },
      };
    case "residential_only":
      return {
        ok: false,
        errorCode: "residential_only",
        message: "That address is a commercial property.",
        say: "Explain Summit Air only services homes.",
      };
    case "missing_name": {
      const missing = [!args.first_name && "first_name", !args.last_name && "last_name"].filter((f): f is string => Boolean(f));
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: `Missing: ${missing.join(", ")}`,
        say: `This is a new customer, so ask for their ${missing.map((f) => f.replace("_", " ")).join(" and ")}.`,
        data: { invalid_fields: missing.map((field) => ({ field, problem: "required for a new customer" })) },
      };
    }
    default:
      return {
        ok: false,
        errorCode: err.code,
        message: `Booking failed: ${err.code.replace(/_/g, " ")}`,
        say: "Something didn't match. Get availability again, or look the caller up again, before retrying.",
        data: { reason: err.code },
      };
  }
}
