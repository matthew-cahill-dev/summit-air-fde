import { z } from "zod";
import { BOROUGH, BUSINESS, coverageOf, type County } from "@/config/business";
import { logEvent } from "@/server/lib/log";
import { optionalArg } from "@/server/lib/optional-arg";
import { normalizePhoneE164 } from "@/server/lib/phone";
import { spokenWindow } from "@/server/lib/time";
import type { BookingAddress, CustomerRow } from "@/server/repositories";
import { seatClaimRules } from "@/server/scheduling/availability";
import { buildTechnicianNotes, type OnSiteContact } from "@/server/scheduling/technician-notes";
import { propertyKind } from "@/server/triage/property";
import { VULNERABLE_OCCUPANTS } from "@/server/triage/rules";
import { defineTool, type ToolContext, type ToolOutcome } from "@/server/vapi/types";
import { findOfferableSlots, isActiveMember } from "./availability";
import { intakeRecord, technicianIntakeShape } from "./intake";
import { requireLookup } from "./lookup-guard";
import { detectSignals, hasSignals, signalPhrases } from "@/server/triage/detect";
import { detectMinor } from "@/server/triage/minor";
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
      | "missing_name"
      | "coverage_check"
      | "not_served",
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

export const EMERGENCY_NOT_BOOKABLE_SAY =
  "This is an emergency: tell them to call 911 now if anyone is in danger, then create_priority_dispatch. Don't book an appointment.";

/** A refusal when this call is an emergency or safety stop (by triage, or by the caller's words). */
async function emergencyOnCall(args: BookArgs, ctx: ToolContext): Promise<ToolOutcome | null> {
  const triaged = ctx.callId ? await ctx.repos.toolInvocations.okResults(ctx.callId, "triage_issue") : [];
  const urgent = triaged.find((r) => r.urgency === "emergency" || r.urgency === "safety_stop");
  const triageSignals = triaged.flatMap((r) => (Array.isArray(r.detected_signals) ? (r.detected_signals as string[]) : []));
  const ownSignals = detectSignals([args.issue_summary, ...args.symptoms].join(". "));
  const detected = [...triageSignals, ...(hasSignals(ownSignals) ? signalPhrases(ownSignals) : [])];
  if (!urgent && detected.length === 0) return null;
  logEvent("booking_refused_emergency", { callId: ctx.callId, triage_urgency: urgent?.urgency ?? null, detected });
  return {
    ok: false,
    errorCode: "emergency_not_bookable",
    message: urgent ? `This call was triaged ${String(urgent.urgency).replace("_", " ")}` : `Safety or medical signs: ${detected.join(", ")}`,
    say: EMERGENCY_NOT_BOOKABLE_SAY,
    data: { triage_urgency: urgent?.urgency ?? null, detected_signals: detected },
  };
}

export const MINOR_CALLER_SAY =
  "This sounds like a child calling. Don't book, and ask the child for nothing except a callback number. Any safety instructions you gave still apply in full. " +
  "Kindly say a grown-up needs to set up the visit. Next: ask for a good number for a parent or guardian (the number they're calling from is fine), then call create_callback_request with reason other and details starting \"Child called about\" and the problem, \"parent or guardian to call back\". " +
  "Then tell them someone from Summit Air will call their parent or guardian back.";

/**
 * A child on the line (docs/LIMITATIONS.md, eval run 7021919d: "my mom is sleeping", "I don't
 * know my last name", booked as "Leo"). Reads what the server can see of the caller's words: the
 * live transcript, triage's caller_description and the booking's own text.
 */
async function minorCaller(args: BookArgs, ctx: ToolContext): Promise<ToolOutcome | null> {
  const triage = ctx.callId ? await ctx.repos.toolInvocations.latestOkArgs(ctx.callId, "triage_issue") : null;
  const text = [ctx.callerText, typeof triage?.caller_description === "string" ? triage.caller_description : null, args.issue_summary, args.access_notes]
    .filter(Boolean)
    .join("\n");
  let signs = detectMinor(text, { missingLastName: false });
  // An unverified booking with no last name is a second sign, unless the number is a known customer's.
  if (!signs.minor && signs.weak.length && !args.customer_id && !args.last_name) {
    const phone = normalizePhoneE164(args.phone ?? ctx.callerPhone ?? "");
    const known = phone ? await ctx.repos.customers.findCallerContextByPhone(phone) : null;
    if (!known) signs = detectMinor(text, { missingLastName: true });
  }
  if (!signs.minor) return null;
  logEvent("booking_refused_minor", { callId: ctx.callId, strong: signs.strong, weak: signs.weak, second: signs.second });
  return {
    ok: false,
    errorCode: "minor_caller",
    message: "This sounds like a child calling: a parent or guardian sets up the visit",
    say: MINOR_CALLER_SAY,
    data: { signs: [...signs.strong, ...signs.weak, ...signs.second] },
  };
}

/** Bronx / Staten Island: never booked; the office confirms coverage first. */
function coverageCheckOutcome(borough: string | null): ToolOutcome {
  const where = borough ?? "that borough";
  return {
    ok: false,
    errorCode: "coverage_check",
    message: `Coverage for ${where} isn't confirmed`,
    say: `Don't book. Say: "Let me have our office confirm whether we can cover that address." Next: call create_callback_request with reason other and details starting "coverage check: ${where}". Don't give a reason or say we don't serve it.`,
    data: { coverage_check: true, borough },
  };
}

const DONT_REBOOK = "Don't call book_appointment again unless the caller changes the window or a detail.";

/** What Ava does next after a successful book_appointment. */
export function bookedSay(b: {
  already: boolean;
  moved: boolean;
  detailsUpdated: boolean;
  window: string;
  address: { line1: string; unit: string | null };
  offerMembership: boolean;
  /** The name an unverified caller gave, said back so a mishearing can be caught (client session 1). */
  name?: string | null;
  nameCorrected?: boolean;
}): string {
  const where = `${b.address.line1}${b.address.unit ? `, unit ${b.address.unit}` : ""}`;
  if (b.nameCorrected && b.name && !b.moved) {
    return `Same booking, name fixed: it's now under ${b.name}. Confirm the name in one short sentence. Next: ask if there's anything else. ${DONT_REBOOK}`;
  }
  if (b.detailsUpdated) {
    return "Same booking, no second appointment: the new detail is now in the technician's notes. Say so in one short sentence (e.g. you've noted they'd like around eight thirty, though it's a window). No callback is needed for this. Next: ask if there's anything else. " + DONT_REBOOK;
  }
  if (b.already) return `Already booked: ${b.window}, at ${where}. Recap it in one sentence. Next: ask if there's anything else. ${DONT_REBOOK}`;
  if (b.moved) {
    return `Changed, not added: their one booking is now ${b.window}, at ${where}, and the earlier window is released. Confirm the new window in one sentence. Next: ask if there's anything else. ${DONT_REBOOK}`;
  }
  const name = b.name
    ? `, under the name ${b.name}. Say the name so they can catch a mistake; if they correct it, call book_appointment again with the same slot_id and the corrected name`
    : "";
  return `Booked. Recap it in one sentence: ${b.window}, at ${where}${name}.` + (b.offerMembership ? MEMBERSHIP_SAY : "") + ` Next: ask if there's anything else. ${DONT_REBOOK}`;
}

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
    // Never book an emergency: not after a priority or safety triage on this call, and not when the
    // booking's own description shows safety or medical signs (eval run 1e753a02 booked heat stroke).
    const emergency = await emergencyOnCall(args, ctx);
    if (emergency) return emergency;
    // Never book for a child; a parent or guardian gets a callback instead.
    const minor = await minorCaller(args, ctx);
    if (minor) return minor;
    // An unverified booking only after lookup_customer has checked for an account (requirement c).
    if (!args.customer_id) {
      const blocked = await requireLookup(ctx, "book_appointment");
      if (blocked) return blocked;
    }
    const rawPhone = args.phone ?? ctx.callerPhone;
    const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : null;
    if (args.phone && !phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Invalid: phone (not a valid phone number)",
        say: "Next: ask for the best callback number again, including area code, then call book_appointment again.",
        data: { invalid_fields: [{ field: "phone", problem: "not a valid phone number" }] },
      };
    }
    const customerId = args.customer_id ?? (phoneE164 ? ctx.settings.demoCallerMap.get(phoneE164) : undefined);
    // Customers this call created: a name the caller corrects after booking may replace theirs, and no one else's.
    const createdThisCall =
      !customerId && ctx.callId
        ? new Set((await ctx.repos.toolInvocations.okResults(ctx.callId, "book_appointment")).filter((r) => r.new_customer === true).map((r) => r.customer_id))
        : new Set<unknown>();
    const statedName = !args.customer_id && args.first_name && args.last_name ? `${args.first_name} ${args.last_name}` : null;
    if (!customerId && !phoneE164) {
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: "Missing: phone",
        say: "Next: ask for the best callback number for the appointment, then call book_appointment again.",
        data: { invalid_fields: [{ field: "phone", problem: "required" }] },
      };
    }

    // New address: check the ZIP up front (outside the transaction).
    let newAddressCounty: string | null = null;
    if (!args.address_id && args.address) {
      const zipRow = await ctx.repos.serviceArea.findZip(args.address.zip);
      const cov = coverageOf(zipRow);
      if (cov.coverage === "coverage_check") return coverageCheckOutcome(cov.borough);
      if (!zipRow?.active) {
        return {
          ok: false,
          errorCode: "out_of_area",
          message: `ZIP ${args.address.zip} is outside the service area`,
          say: `Confirm the ZIP. If it's right, explain we only serve homes in ${BUSINESS.facts.serviceArea}. Next: if it was misheard, call triage_issue again with the corrected ZIP; otherwise ask if there's anything else.`,
        };
      }
      newAddressCounty = zipRow.county;
    }

    // Residential unless this call's triage said otherwise (it opens the technician notes).
    const property = (ctx.callId ? propertyKind(await ctx.repos.toolInvocations.latestOkArgs(ctx.callId, "triage_issue")) : null) ?? "residential";

    const cfg = BUSINESS.scheduling;
    let newCustomer = false;
    let nameCorrected = false;
    // An unverified caller's name that differs from the stored customer on this phone, kept on the visit, never on the account.
    let otherStatedName: string | null = null;
    let slotCounty: string | null = null;
    let resolvedCustomerId: string | undefined = customerId;

    try {
      const booked = await ctx.repos.scheduling.runBooking(async (tx) => {
        // Two book_appointment calls from one phone call never interleave (one appointment per call).
        if (ctx.callId) await tx.lockCall(ctx.callId);
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
          } else if (statedName && `${customer.firstName} ${customer.lastName}`.toLowerCase() !== statedName.toLowerCase()) {
            if (createdThisCall.has(customer.id)) {
              // Corrected after the recap (client session 1: the name was recorded wrong and never said back).
              await tx.updateCustomerName(customer.id, { firstName: args.first_name!, lastName: args.last_name! });
              customer = { ...customer, firstName: args.first_name!, lastName: args.last_name! };
              nameCorrected = true;
            } else {
              otherStatedName = statedName;
            }
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
        // An address on file outside the served counties (e.g. Staten Island) is never booked,
        // even if an old arrival window for that county still exists.
        if (!address.county || !(BUSINESS.serviceCounties as readonly string[]).includes(address.county)) {
          const coverageCheck = Boolean(address.county && (BUSINESS.coverageCheckCounties as readonly string[]).includes(address.county));
          throw new BookingRejected(coverageCheck ? "coverage_check" : "not_served", address.county);
        }
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
          ...(otherStatedName ? { caller_stated_name: otherStatedName } : {}),
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

        // One active appointment per call. Same window again (the caller holds it): no second
        // booking; added details (an arrival preference, pets, a code) update its notes. A
        // different window in the same call is a change: the call's appointment moves and its
        // old seat is released.
        const callAppt = ctx.callId ? await tx.findCallAppointment(ctx.callId) : null;
        const existing = await tx.findAppointment(customer.id, slot.id);
        if (existing?.status === "confirmed") {
          const merged = mergeIntake(existing.intake, newIntake);
          const changed = JSON.stringify(merged) !== JSON.stringify(existing.intake ?? {});
          // A corrected name changes the technician notes even when the intake didn't change.
          if (changed || nameCorrected) await tx.updateAppointmentDetails(existing.id, { intake: merged, technicianNotes: notesFor(merged) });
          if (callAppt && callAppt.id !== existing.id) {
            await tx.cancelAppointment(callAppt.id);
            await tx.releaseSeat(callAppt.slotId);
          }
          return { appointmentId: existing.id, already: true, moved: false, detailsUpdated: changed, slot, address, customer, isMember };
        }

        const claimed = await tx.claimSeat(slot.id, seatClaimRules(ctx.now, isMember, cfg));
        if (!claimed) throw new BookingRejected("slot_taken", slot.county); // the call's booking (if any) stands

        const intake = callAppt ? mergeIntake(callAppt.intake, newIntake) : newIntake;
        const fields = {
          slotId: slot.id,
          customerId: customer.id,
          addressId: address.id,
          serviceType: args.service_type,
          urgency: args.urgency,
          issueSummary: args.issue_summary,
          symptoms: args.symptoms,
          intake,
          technicianNotes: notesFor(intake),
          vapiCallId: ctx.callId,
        };
        let appointmentId: string;
        if (existing) {
          // A cancelled booking of this customer in this window: bring it back (unique per customer and window).
          await tx.replaceAppointment(existing.id, fields);
          appointmentId = existing.id;
          if (callAppt) {
            await tx.cancelAppointment(callAppt.id);
            await tx.releaseSeat(callAppt.slotId);
          }
        } else if (callAppt) {
          await tx.replaceAppointment(callAppt.id, fields);
          await tx.releaseSeat(callAppt.slotId);
          appointmentId = callAppt.id;
        } else {
          appointmentId = (await tx.insertAppointment(fields)).id;
        }
        return { appointmentId, already: false, moved: Boolean(callAppt), detailsUpdated: false, slot, address, customer, isMember };
      });

      const window = spokenWindow(booked.slot.startsAt, booked.slot.endsAt, ctx.settings.timeZone, ctx.now);
      logEvent("appointment_booked", { callId: ctx.callId, already: booked.already, moved: booked.moved, newCustomer, nameCorrected, otherStatedName: Boolean(otherStatedName) });
      // A replay (already) or a change never re-offers: the caller heard it the first time.
      const offerMembership =
        !booked.already &&
        !booked.moved &&
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
          changed_window: booked.moved,
          ...(nameCorrected ? { name_corrected: true } : {}),
        },
        say: bookedSay({ ...booked, window, offerMembership, name: statedName, nameCorrected }),
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
            say: `Booked. Recap the window and address in one sentence. Next: ask if there's anything else. ${DONT_REBOOK}`,
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
          ? "Apologize: that window was just taken. Next: offer these alternatives; when they pick one, confirm it in one sentence and call book_appointment with the new slot_id (same details)."
          : "Apologize: that window was just taken and nothing else is open. Next: offer a callback from the office with create_callback_request.",
      };
    }
    case "slot_wrong_area":
      return {
        ok: false,
        errorCode: "slot_wrong_area",
        message: "That window is for a different borough than the service address.",
        say: "Next: call get_availability for the service address's ZIP and offer those windows.",
        data: { reason: "slot_wrong_area" },
      };
    case "residential_only":
      return {
        ok: false,
        errorCode: "residential_only",
        message: "That address is a commercial property.",
        say: "Explain Summit Air only services homes. Next: thank them and end the call.",
      };
    case "coverage_check":
      return coverageCheckOutcome(err.county ? (BOROUGH[err.county as County] ?? err.county) : null);
    case "not_served":
      return {
        ok: false,
        errorCode: "out_of_area",
        message: "That address is outside the service area.",
        say: `Confirm the address. If it's right, explain we only serve homes in ${BUSINESS.facts.serviceArea}. Next: ask if there's anything else.`,
      };
    case "missing_name": {
      const missing = [!args.first_name && "first_name", !args.last_name && "last_name"].filter((f): f is string => Boolean(f));
      return {
        ok: false,
        errorCode: "invalid_arguments",
        message: `Missing: ${missing.join(", ")}`,
        say: `This is a new customer. Next: ask for their ${missing.map((f) => f.replace("_", " ")).join(" and ")}, then call book_appointment again with the same details.`,
        data: { invalid_fields: missing.map((field) => ({ field, problem: "required for a new customer" })) },
      };
    }
    default:
      return {
        ok: false,
        errorCode: err.code,
        message: `Booking failed: ${err.code.replace(/_/g, " ")}`,
        say: "Something didn't match. Next: call get_availability again for the service address's ZIP, or look the caller up again, before retrying once.",
        data: { reason: err.code },
      };
  }
}
