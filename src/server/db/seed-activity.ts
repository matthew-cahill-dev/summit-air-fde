// Demo call activity for the operations console: one call per outcome (booked,
// priority dispatch, safety stop, callback, not serviceable, incomplete), their
// tool timelines, board items and upcoming appointments. Every row is flagged
// is_demo_seed so the console can tag or hide it and db:reset-test keeps it.
// Re-running replaces all demo activity with fresh rows timed relative to `now`.
// All people, phones and addresses are fictional (555-01xx numbers, seed customers).
// Keep this file free of path aliases: it is also compiled for the seed script.
import { and, eq } from "drizzle-orm";
import { nextBusinessDays, todayInZone, zonedTimeToUtc } from "../lib/time";
import type { Db } from "./client";
import { appointments, appointmentSlots, callbackRequests, calls, dispatchRequests, toolInvocations } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Seed customers used here are deliberately not the reviewer personas in the README.
const ROSALIND = "00000000-0000-4000-8000-000000000006";
const GRACE = "00000000-0000-4000-8000-000000000009";
const HECTOR = "00000000-0000-4000-8000-000000000010";
const WEN = "00000000-0000-4000-8000-000000000011";
const BEA = "00000000-0000-4000-8000-000000000012";

const ADDR = {
  rosalind: "00000000-0000-4000-8001-000000000006",
  graceSI: "00000000-0000-4000-8001-000000000009",
  graceQueens: "00000000-0000-4000-8001-000000000010",
  wen: "00000000-0000-4000-8001-000000000012",
};

const id = (group: number, n: number) => `00000000-0000-4000-9${String(group).padStart(3, "0")}-${String(n).padStart(12, "0")}`;
const callId = (n: number) => `demo-seed-call-${String(n).padStart(2, "0")}`;

type Inv = { tool: string; args: Record<string, unknown>; result: Record<string, unknown>; ok?: boolean; ms: number; dbMs: number; at: number };

export type ActivitySummary = { calls: number; toolInvocations: number; appointments: number; dispatchRequests: number; callbackRequests: number };

export async function seedDemoActivity(tx: Tx, opts: { timeZone: string; now?: Date }): Promise<ActivitySummary> {
  const now = opts.now ?? new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const days = nextBusinessDays(todayInZone(opts.timeZone, now), 3);

  async function slotId(county: string, dayIdx: number, startHour: number) {
    const startsAt = zonedTimeToUtc(days[dayIdx], startHour, 0, opts.timeZone);
    const [row] = await tx
      .select({ id: appointmentSlots.id })
      .from(appointmentSlots)
      .where(and(eq(appointmentSlots.county, county), eq(appointmentSlots.startsAt, startsAt)))
      .limit(1);
    return row?.id ?? null;
  }

  // Replace, don't upsert: simplest way to stay idempotent across unique constraints.
  await tx.delete(appointments).where(eq(appointments.isDemoSeed, true));
  await tx.delete(dispatchRequests).where(eq(dispatchRequests.isDemoSeed, true));
  await tx.delete(callbackRequests).where(eq(callbackRequests.isDemoSeed, true));
  await tx.delete(toolInvocations).where(eq(toolInvocations.isDemoSeed, true));
  await tx.delete(calls).where(eq(calls.isDemoSeed, true));

  const invocationRows: Array<typeof toolInvocations.$inferInsert> = [];
  const callRows: Array<typeof calls.$inferInsert> = [];

  function addCall(
    n: number,
    c: {
      phone: string;
      startedMinAgo: number;
      durationSec?: number;
      endedReason?: string;
      summary?: string;
      transcript?: string;
      invocations: Inv[];
    },
  ) {
    const started = ago(c.startedMinAgo);
    if (c.durationSec !== undefined) {
      callRows.push({
        vapiCallId: callId(n),
        callerPhone: c.phone,
        startedAt: started,
        endedAt: new Date(started.getTime() + c.durationSec * 1000),
        endedReason: c.endedReason ?? "customer-ended-call",
        summary: c.summary ?? null,
        transcript: c.transcript ?? null,
        rawReport: { demo_seed: true },
        isTest: false,
        isDemoSeed: true,
      });
    }
    c.invocations.forEach((inv, i) => {
      const ok = inv.ok ?? true;
      invocationRows.push({
        idempotencyKey: `${callId(n)}:${i}:${inv.tool}`,
        vapiCallId: callId(n),
        toolName: inv.tool,
        args: inv.args,
        ok,
        result: { ok, ...inv.result },
        latencyMs: inv.ms,
        dbMs: inv.dbMs,
        createdAt: new Date(started.getTime() + inv.at * 1000),
        isDemoSeed: true,
      });
    });
  }

  // 1. Booked: routine furnace tune-up for a returning customer (2h ago).
  addCall(1, {
    phone: "+19175550111",
    startedMinAgo: 128,
    durationSec: 214,
    summary:
      "Wen Larkspur called to book a furnace tune-up before winter at 7520 Ridge Blvd. Verified by caller ID and street address. Booked a routine maintenance visit for the next business day, 8 to 10 AM.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: Hi, I'd like to get my furnace checked before it gets cold.",
      "AI: Happy to help with that. What's the street address for the service?",
      "User: 7520 Ridge Boulevard.",
      "AI: Thanks, Wen, I've found your account. Is the furnace working right now, or is this a routine tune-up?",
      "User: It's working, just the yearly tune-up.",
      "AI: I have tomorrow between 8 and 10 AM, or between 10 AM and 1 PM. Which works better?",
      "User: 8 to 10 is great.",
      "AI: To confirm: a furnace tune-up at 7520 Ridge Blvd, tomorrow between 8 and 10 AM. Shall I book it?",
      "User: Yes please.",
      "AI: You're all set. The technician will call when they're on the way. Anything else?",
      "User: No, that's it. Thanks!",
    ].join("\n"),
    invocations: [
      { tool: "lookup_customer", args: {}, result: { found: true, verified: false, verification_required: true }, ms: 96, dbMs: 41, at: 9 },
      { tool: "lookup_customer", args: { street_address: "7520 Ridge Boulevard" }, result: { found: true, verified: true, matched_by: "phone", customer_id: WEN, first_name: "Wen", is_member: false }, ms: 88, dbMs: 37, at: 21 },
      { tool: "triage_issue", args: { issue_type: "maintenance", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, property_type: "residential", zip: "11209", customer_id: WEN }, result: { urgency: "routine", reasons: ["Routine request: maintenance"], serviceable: true, in_area: true, county: "Kings", next_action: "book_standard" }, ms: 142, dbMs: 63, at: 52 },
      { tool: "book_appointment", args: { slot_id: "(seed slot)", caller_confirmed: true, customer_id: WEN, address_id: ADDR.wen, service_type: "maintenance", urgency: "routine", issue_summary: "Annual furnace tune-up" }, result: { booked: true, already_booked: false, new_customer: false, customer_id: WEN }, ms: 231, dbMs: 118, at: 141 },
    ],
  });

  // 2. Priority dispatch: no heat with an elderly parent (9 minutes ago, still open).
  addCall(2, {
    phone: "+13475550110",
    startedMinAgo: 12,
    durationSec: 236,
    endedReason: "assistant-ended-call",
    summary:
      "Hector Alvarenga-Stout reported no heat at 164-20 Highland Ave with his 84-year-old mother at home and the house at 58°F. Triaged as an emergency and logged a priority dispatch; told the on-call team will call back within 15 minutes.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: Our boiler stopped and there's no heat. My mother is 84 and she lives with me.",
      "AI: I'm sorry, that sounds stressful. Do you know roughly how warm it is inside right now?",
      "User: The thermostat says 58.",
      "AI: Any smell of gas, or a carbon monoxide alarm going off?",
      "User: No, nothing like that.",
      "AI: Because of the cold and your mother's age, I'm treating this as a priority. What's the address and the best number to reach you?",
      "User: 164-20 Highland Avenue in Jamaica, and this number is fine.",
      "AI: I've logged a priority request. Our policy is for the on-call team to call you back within 15 minutes at this number. If anyone feels unwell before then, please call 911.",
    ].join("\n"),
    invocations: [
      { tool: "lookup_customer", args: {}, result: { found: true, verified: false, verification_required: true }, ms: 104, dbMs: 45, at: 11 },
      { tool: "triage_issue", args: { issue_type: "no_heat", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, vulnerable_occupants: ["elderly"], indoor_temp_f: 58, property_type: "residential", zip: "11432" }, result: { urgency: "emergency", reasons: ["No heat during heat season (Oct 1 to May 31) with vulnerable occupants: elderly"], serviceable: true, in_area: true, county: "Queens", next_action: "priority_dispatch", offer_transfer: false }, ms: 61, dbMs: 22, at: 58 },
      { tool: "create_priority_dispatch", args: { first_name: "Hector", last_name: "Alvarenga-Stout", address: { line1: "164-20 Highland Ave", city: "Jamaica", zip: "11432" }, issue_type: "no_heat", issue_summary: "Boiler stopped, no heat, house at 58°F", vulnerable_occupants: ["elderly"], indoor_temp_f: 58 }, result: { dispatch_id: id(2, 1), status: "open", callback_sla_minutes: 15 }, ms: 77, dbMs: 31, at: 171 },
    ],
  });

  // 3. Safety stop: CO alarm (26 minutes ago, open, past the 15-minute SLA).
  addCall(3, {
    phone: "+17185550142",
    startedMinAgo: 27,
    durationSec: 95,
    summary:
      "Caller reported a carbon monoxide alarm sounding in the basement near the furnace at a home in ZIP 11218. Given leave-now instructions and told to call 911 from outside; told Summit Air has not contacted 911. Office follow-up needed.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: Our carbon monoxide alarm is going off downstairs by the furnace.",
      "AI: Please leave the home now with everyone, and don't switch anything on or off on the way out. Once you're outside, call 911. Summit Air has not called 911 for you.",
      "User: Okay, we're going outside now.",
      "AI: Thank you. Our office has a note to follow up once you're safe. What ZIP code is the home in?",
      "User: 11218.",
    ].join("\n"),
    invocations: [
      { tool: "triage_issue", args: { issue_type: "other", gas_smell: false, co_alarm: true, burning_smell_or_smoke: false, vulnerable_occupants: ["infant"], property_type: "residential", zip: "11218" }, result: { urgency: "safety_stop", reasons: ["Carbon monoxide alarm reported"], serviceable: true, in_area: true, county: "Kings", next_action: "safety_instructions", office_followup_recorded: true }, ms: 54, dbMs: 19, at: 24 },
    ],
  });

  // 4. Callback: urgent no heat but no windows in 48h (41 minutes ago).
  addCall(4, {
    phone: "+17185550112",
    startedMinAgo: 41,
    durationSec: 188,
    summary:
      "Bea Castellwood (member) has a heat pump blowing cold air at 312 Amboy Rd. Triaged urgent, but no Staten Island windows were open in the next 48 hours, so a callback was logged for the office to find the earliest slot.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: My heat pump is only blowing cold air.",
      "AI: I'm sorry about that. Is anyone at home elderly, an infant, or someone with a medical condition?",
      "User: No, just me.",
      "AI: I'm not seeing any open windows in the next two days for your area. I'll have the office call you back to fit you in as early as possible.",
      "User: Okay, thank you.",
    ].join("\n"),
    invocations: [
      { tool: "lookup_customer", args: { street_address: "312 Amboy Road" }, result: { found: true, verified: true, matched_by: "phone", customer_id: BEA, first_name: "Bea", is_member: true }, ms: 112, dbMs: 52, at: 17 },
      { tool: "triage_issue", args: { issue_type: "no_heat", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, property_type: "residential", zip: "10306", customer_id: BEA }, result: { urgency: "urgent", reasons: ["No heat during heat season (Oct 1 to May 31)"], serviceable: true, in_area: true, county: "Richmond", next_action: "create_callback", offered_slots: [] }, ms: 158, dbMs: 74, at: 63 },
      { tool: "create_callback_request", args: { reason: "other", details: "Heat pump blowing cold air; no windows in the next 48 hours. Wants the earliest visit.", caller_name: "Bea Castellwood" }, result: { callback_id: id(3, 1), status: "open" }, ms: 69, dbMs: 27, at: 150 },
    ],
  });

  // 5. Callback: asked for a person about a replacement quote (1h35m ago).
  addCall(5, {
    phone: "+17185550109",
    startedMinAgo: 95,
    durationSec: 122,
    summary:
      "Grace Nakamori-Lowe asked about replacing the 2017 furnace at 45 Bayview Ter and wanted to speak with someone about pricing. Installation quotes aren't given by phone, so an office callback was logged.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: I'm thinking about replacing my furnace. Can I get a price?",
      "AI: We don't quote replacements over the phone, but I can have someone from the office call you back to talk it through. Would that help?",
      "User: Yes, please have someone call me.",
    ].join("\n"),
    invocations: [
      { tool: "create_callback_request", args: { reason: "human_requested", details: "Wants a furnace replacement quote for 45 Bayview Ter (2017 Goodman).", caller_name: "Grace Nakamori-Lowe" }, result: { callback_id: id(3, 2), status: "open" }, ms: 73, dbMs: 30, at: 88 },
    ],
  });

  // 6. Not serviceable: Manhattan address (3h ago).
  addCall(6, {
    phone: "+12125550108",
    startedMinAgo: 184,
    durationSec: 97,
    summary:
      "Jordan Pikesbury asked for AC service at 600 W 110th St, Manhattan (ZIP 10025). Outside the service area (Brooklyn, Queens, Staten Island); explained and closed politely.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: My AC is making a rattling noise. I'm on the Upper West Side.",
      "AI: What's the ZIP code there?",
      "User: 10025.",
      "AI: I'm sorry, we only serve Brooklyn, Queens and Staten Island, so we can't send a technician to that address.",
    ].join("\n"),
    invocations: [
      { tool: "triage_issue", args: { issue_type: "noise", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, property_type: "residential", zip: "10025" }, result: { urgency: "routine", reasons: ["Routine request: noise", "ZIP 10025 is outside the service area"], serviceable: false, not_serviceable_reason: "out_of_area", in_area: false, county: null, next_action: "explain_and_close" }, ms: 47, dbMs: 15, at: 49 },
    ],
  });

  // 7. Incomplete: hung up during verification (4h ago), with one failed tool call.
  addCall(7, {
    phone: "+13475550199",
    startedMinAgo: 247,
    durationSec: 41,
    summary: "Caller started to describe a thermostat problem, then hung up before giving an address. No follow-up details captured.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: Hi, my thermostat screen is blank and...",
      "AI: Let me look that up. What's the street address for the service?",
    ].join("\n"),
    invocations: [
      { tool: "lookup_customer", args: { phone: "347-555-019" }, result: { error_code: "invalid_arguments", message: "Invalid: phone (not a valid phone number)" }, ok: false, ms: 12, dbMs: 0, at: 27 },
    ],
  });

  // 8. Booked urgent: active leak in a doorman building (52 minutes ago).
  addCall(8, {
    phone: "+13475550106",
    startedMinAgo: 52,
    durationSec: 251,
    summary:
      "Rosalind Achterberg reported water pooling under the heat pump air handler in unit 3A at 190 Kent Ave. Triaged urgent (active leak) and booked the earliest window; front-desk check-in noted for the technician.",
    transcript: [
      "AI: Hi, thanks for calling Summit Air! This is Ava, the virtual assistant. What's going on today?",
      "User: There's water leaking under my heat pump unit.",
      "AI: Thanks for letting me know. Is it actively dripping right now?",
      "User: Yes, there's a puddle.",
      "AI: I can get someone out tomorrow between 10 AM and 1 PM. Does that work?",
      "User: Yes.",
      "AI: Booked: tomorrow between 10 AM and 1 PM at 190 Kent Ave, unit 3A. The technician will check in at the front desk.",
    ].join("\n"),
    invocations: [
      { tool: "lookup_customer", args: { street_address: "190 Kent Avenue" }, result: { found: true, verified: true, matched_by: "phone", customer_id: ROSALIND, first_name: "Rosalind", is_member: false }, ms: 91, dbMs: 39, at: 14 },
      { tool: "triage_issue", args: { issue_type: "leak", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, property_type: "residential", zip: "11249", customer_id: ROSALIND }, result: { urgency: "urgent", reasons: ["Active leak reported"], serviceable: true, in_area: true, county: "Kings", next_action: "book_earliest" }, ms: 166, dbMs: 81, at: 70 },
      { tool: "book_appointment", args: { slot_id: "(seed slot)", caller_confirmed: true, customer_id: ROSALIND, address_id: ADDR.rosalind, service_type: "repair", urgency: "urgent", issue_summary: "Water leaking under heat pump air handler" }, result: { booked: true, already_booked: false, new_customer: false, customer_id: ROSALIND }, ms: 244, dbMs: 127, at: 203 },
    ],
  });

  // 9. Yesterday's emergency, already resolved (feeds the activity history).
  addCall(9, {
    phone: "+17185550123",
    startedMinAgo: 60 * 20,
    durationSec: 203,
    summary: "No cooling in a top-floor apartment with a resident on home oxygen; indoor 88°F. Priority dispatch logged and later resolved by the on-call team.",
    invocations: [
      { tool: "triage_issue", args: { issue_type: "no_cooling", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, vulnerable_occupants: ["medical_equipment"], indoor_temp_f: 88, property_type: "residential", zip: "11385" }, result: { urgency: "emergency", reasons: ["No cooling with medically vulnerable occupants: medical equipment, indoor temperature 88°F (at or above 85°F)"], serviceable: true, in_area: true, county: "Queens", next_action: "priority_dispatch" }, ms: 58, dbMs: 21, at: 40 },
      { tool: "create_priority_dispatch", args: { first_name: "Ines", last_name: "Calderwood", address: { line1: "66-12 Forest Ave", unit: "4R", city: "Ridgewood", zip: "11385" }, issue_type: "no_cooling", issue_summary: "AC out, resident on home oxygen", vulnerable_occupants: ["medical_equipment"], indoor_temp_f: 88 }, result: { dispatch_id: id(2, 3), status: "open", callback_sla_minutes: 15 }, ms: 83, dbMs: 33, at: 160 },
    ],
  });

  // 10. Hung up after triage, before choosing a time: incomplete. (Seed calls always have a
  // report, so the console never shows demo data as "In progress".)
  addCall(10, {
    phone: "+19175550177",
    startedMinAgo: 34,
    durationSec: 96,
    endedReason: "customer-ended-call",
    summary:
      "Caller in Astoria (11105) asked about a thermostat that won't hold its setting. Triage was routine and windows were offered, but the caller hung up before choosing one. No booking; consider a courtesy callback.",
    invocations: [
      { tool: "lookup_customer", args: {}, result: { found: false, verified: false }, ms: 83, dbMs: 36, at: 8 },
      { tool: "triage_issue", args: { issue_type: "thermostat", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, property_type: "residential", zip: "11105" }, result: { urgency: "routine", reasons: ["Routine request: thermostat"], serviceable: true, in_area: true, county: "Queens", next_action: "book_standard" }, ms: 149, dbMs: 70, at: 61 },
    ],
  });

  if (callRows.length) await tx.insert(calls).values(callRows);
  if (invocationRows.length) await tx.insert(toolInvocations).values(invocationRows);

  const dispatchRows: Array<typeof dispatchRequests.$inferInsert> = [
    {
      id: id(2, 1),
      customerId: HECTOR,
      callerPhone: "+13475550110",
      callerName: "Hector Alvarenga-Stout",
      address: { line1: "164-20 Highland Ave", city: "Jamaica", zip: "11432", access_notes: "Side gate is unlocked; boiler room through the back door." },
      urgency: "emergency",
      reasons: ["No heat during heat season (Oct 1 to May 31) with vulnerable occupants: elderly"],
      intake: { issue_type: "no_heat", issue_summary: "Boiler stopped, no heat, house at 58°F", symptoms: ["boiler not firing"], vulnerable_occupants: ["elderly"], indoor_temp_f: 58 },
      status: "open",
      vapiCallId: callId(2),
      createdAt: ago(9),
      isDemoSeed: true,
    },
    {
      id: id(2, 2),
      customerId: null,
      callerPhone: "+17185550142",
      callerName: null,
      address: { zip: "11218" },
      urgency: "safety_stop",
      reasons: ["Carbon monoxide alarm reported"],
      intake: { source: "triage_issue", flags: { issue_type: "other", co_alarm: true, gas_smell: false, vulnerable_occupants: ["infant"], zip: "11218" } },
      status: "open",
      vapiCallId: callId(3),
      createdAt: ago(26),
      isDemoSeed: true,
    },
    {
      id: id(2, 3),
      customerId: null,
      callerPhone: "+17185550123",
      callerName: "Ines Calderwood",
      address: { line1: "66-12 Forest Ave", unit: "4R", city: "Ridgewood", zip: "11385" },
      urgency: "emergency",
      reasons: ["No cooling with medically vulnerable occupants: medical equipment, indoor temperature 88°F (at or above 85°F)"],
      intake: { issue_type: "no_cooling", issue_summary: "AC out, resident on home oxygen", vulnerable_occupants: ["medical_equipment"], indoor_temp_f: 88 },
      status: "resolved",
      vapiCallId: callId(9),
      createdAt: ago(60 * 20 - 3),
      acknowledgedAt: ago(60 * 20 - 9),
      resolvedAt: ago(60 * 18),
      isDemoSeed: true,
    },
  ];
  await tx.insert(dispatchRequests).values(dispatchRows);

  const callbackRows: Array<typeof callbackRequests.$inferInsert> = [
    {
      id: id(3, 1),
      callerPhone: "+17185550112",
      callerName: "Bea Castellwood",
      reason: "other",
      context: { details: "Heat pump blowing cold air; no windows in the next 48 hours. Wants the earliest visit.", address: { line1: "312 Amboy Rd", city: "Staten Island", zip: "10306", access_notes: "Dog in yard; please call on arrival." } },
      status: "open",
      vapiCallId: callId(4),
      createdAt: ago(38),
      isDemoSeed: true,
    },
    {
      id: id(3, 2),
      callerPhone: "+17185550109",
      callerName: "Grace Nakamori-Lowe",
      reason: "human_requested",
      context: { details: "Wants a furnace replacement quote for 45 Bayview Ter (2017 Goodman)." },
      status: "open",
      vapiCallId: callId(5),
      createdAt: ago(93),
      isDemoSeed: true,
    },
  ];
  await tx.insert(callbackRequests).values(callbackRows);

  // Upcoming appointments. Seed slot "booked" counts are synthetic and already
  // include bookings like these, so demo appointments don't take extra seats.
  const plans = [
    { n: 1, customerId: WEN, addressId: ADDR.wen, county: "Kings", day: 0, hour: 8, serviceType: "maintenance" as const, urgency: "routine" as const, issue: "Annual furnace tune-up", call: callId(1), createdAt: ago(126),
      notes: "Routine maintenance: annual furnace tune-up.\nEquipment on file: Rheem furnace (2013), Rheem central AC (2013).\nBooked by phone; customer verified by caller ID and street address." },
    { n: 2, customerId: ROSALIND, addressId: ADDR.rosalind, county: "Kings", day: 0, hour: 10, serviceType: "repair" as const, urgency: "urgent" as const, issue: "Water leaking under heat pump air handler", call: callId(8), createdAt: ago(49),
      notes: "URGENT: active leak under the heat pump air handler, puddle on the floor.\nEquipment on file: Bosch heat pump (2022).\nAccess: doorman building; check in at the front desk. Unit 3A." },
    { n: 3, customerId: GRACE, addressId: ADDR.graceSI, county: "Richmond", day: 1, hour: 13, serviceType: "maintenance" as const, urgency: "routine" as const, issue: "Fall furnace and AC check", call: null, createdAt: ago(60 * 26),
      notes: "Member (Comfort Club): seasonal check of Goodman furnace and central AC (2017).\nCustomer is also requesting a replacement quote; see open callback." },
    { n: 4, customerId: GRACE, addressId: ADDR.graceQueens, county: "Queens", day: 2, hour: 8, serviceType: "diagnostic" as const, urgency: "routine" as const, issue: "Mini-split clicking noise in bedroom", call: null, createdAt: ago(60 * 30),
      notes: "Diagnostic: intermittent clicking from the Fujitsu mini-split (2020) in the bedroom.\nAccess: rental unit 6D; call the tenant first, tenant will let the tech in." },
  ];
  let appointmentCount = 0;
  for (const p of plans) {
    const slot = await slotId(p.county, p.day, p.hour);
    if (!slot) continue;
    const inserted = await tx
      .insert(appointments)
      .values({
        id: id(4, p.n),
        slotId: slot,
        customerId: p.customerId,
        addressId: p.addressId,
        serviceType: p.serviceType,
        urgency: p.urgency,
        issueSummary: p.issue,
        symptoms: [],
        intake: { demo_seed: true },
        technicianNotes: p.notes,
        status: "confirmed",
        vapiCallId: p.call,
        createdAt: p.createdAt,
        isDemoSeed: true,
      })
      // A real booking of the same customer + window wins; skip the demo row.
      .onConflictDoNothing()
      .returning({ id: appointments.id });
    appointmentCount += inserted.length;
  }

  return {
    calls: callRows.length,
    toolInvocations: invocationRows.length,
    appointments: appointmentCount,
    dispatchRequests: dispatchRows.length,
    callbackRequests: callbackRows.length,
  };
}
