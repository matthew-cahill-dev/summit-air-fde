// Summit Air business configuration.
// Everything here is an ASSUMPTION for the demo until confirmed with the business.
// Keep this file free of path aliases: it is also compiled for the seed script.

export type County = "Kings" | "Queens" | "Richmond";

export type MonthDay = { month: number; day: number };
export type Season = { start: MonthDay; end: MonthDay };
export type VulnerableOccupant =
  | "elderly"
  | "infant"
  | "medical_condition"
  | "pregnant"
  | "medical_equipment"
  | "disability";

export const BUSINESS = {
  name: "Summit Air",

  // ASSUMPTION: residential customers only; commercial properties are declined.
  residentialOnly: true,

  // ASSUMPTION: heat season runs Oct 1 through May 31 (NYC heat season).
  // Month is 1-based.
  heatSeason: {
    start: { month: 10, day: 1 },
    end: { month: 5, day: 31 },
  } satisfies Season,

  // ASSUMPTION: cooling season runs Jun 1 through Sep 30 (the rest of the year).
  coolingSeason: {
    start: { month: 6, day: 1 },
    end: { month: 9, day: 30 },
  } satisfies Season,

  // ASSUMPTION: a priority-dispatch request gets a human callback within 15 minutes.
  priorityDispatchCallbackSlaMinutes: 15,

  // ASSUMPTION: an office callback request (backend failure, out of area, human requested,
  // incomplete call) should be returned within 2 hours. The console flags older open
  // callbacks as overdue; business hours aren't taken into account.
  callbackRequestSlaMinutes: 120,

  // ASSUMPTION: we serve Brooklyn (Kings), Queens and Staten Island (Richmond).
  serviceCounties: ["Kings", "Queens", "Richmond"] as const satisfies readonly County[],

  triage: {
    // ASSUMPTION: no heat with indoor temperature at or below this is an emergency in any season.
    noHeatEmergencyMaxIndoorTempF: 55,
    // ASSUMPTION: no cooling with indoor temperature at or above this (plus a medical
    // vulnerability) is an emergency even outside cooling season.
    noCoolingEmergencyMinIndoorTempF: 85,
    // ASSUMPTION: occupants at high risk of heat illness (CDC high-risk groups) count as a
    // "medical vulnerability" for the no-cooling EMERGENCY rule. Pregnancy and disability
    // alone don't. Any vulnerable occupant still makes no cooling at least urgent in any season.
    coolingMedicalVulnerabilities: [
      "elderly",
      "infant",
      "medical_condition",
      "medical_equipment",
    ] as const satisfies readonly VulnerableOccupant[],
  },

  scheduling: {
    // ASSUMPTION: urgent calls are offered arrival windows starting within 48 hours.
    urgentWindowHours: 48,
    // ASSUMPTION: routine calls are offered windows up to 14 days out.
    routineHorizonDays: 14,
    // ASSUMPTION: a window must start at least 2 hours from now to be offered or booked.
    bookingLeadTimeMinutes: 120,
    // ASSUMPTION: "members get first pick" = the last seat in any window starting within
    // the next 48 hours is held for active members.
    memberReservedSeatsPerSlot: 1,
    memberPriorityWindowHours: 48,
    // How many windows the agent offers at once (one tool call, then offer times).
    maxOfferedSlots: 3,
    // ASSUMPTION: "morning" = windows starting before noon; "afternoon" = noon or later.
    morningEndsHour: 12,
  },

  // Business facts the agent may state. Every value is an ASSUMPTION for the owner to confirm.
  facts: {
    // ASSUMPTION: fictional office number (555-01xx range).
    officePhoneDisplay: "(718) 555-0100",
    officePhoneSpoken: "seven one eight, five five five, zero one zero zero",
    // ASSUMPTION: office phone hours.
    officeHours: "Monday to Friday 8 AM to 6 PM, and Saturday 9 AM to 2 PM",
    // ASSUMPTION: technician arrival windows offered on weekdays only.
    appointmentHours: "Monday to Friday, with arrival windows between 8 AM and 5 PM",
    // ASSUMPTION: on-call team handles priority-dispatch callbacks around the clock.
    onCallCoverage: "Our on-call team handles priority calls 24 hours a day, 7 days a week.",
    // ASSUMPTION: diagnostic visit fee.
    diagnosticFee: "$129 for a diagnostic visit, waived for active Comfort Club members",
    // ASSUMPTION: membership plans and benefits.
    membershipPlans: [
      "Comfort Club: $19 a month. One heating and one cooling tune-up a year, priority scheduling, no diagnostic fee, and 15 percent off repairs.",
      "Comfort Club Plus: $29 a month. Everything in Comfort Club, plus 20 percent off repairs and no after-hours fee.",
    ],
    // ASSUMPTION: what we service.
    servicesOffered:
      "Repair, maintenance and diagnostics for furnaces, boilers, central air, heat pumps and ductless mini-splits, all major brands, in homes only.",
    // ASSUMPTION: things we don't do over the phone.
    notOffered:
      "We don't service commercial properties, and we don't quote installation or replacement prices over the phone. The office can call back about installations.",
    // ASSUMPTION: the one-sentence Comfort Club mention after a non-member books routine maintenance.
    // Completes "mention in one sentence that ...".
    membershipPitch:
      "our Comfort Club membership is $19 a month and covers a heating and a cooling tune-up each year, priority scheduling and no diagnostic fee.",
    // ASSUMPTION: member benefits the agent mentions briefly to a verified active member, when relevant.
    memberBenefits: "priority scheduling, and the diagnostic fee is waived",
    // ASSUMPTION: payment.
    payment: "Payment is due at the time of service by card or check.",
    serviceArea: "Brooklyn, Queens and Staten Island",
  },
} as const;

// ASSUMPTION: service area is defined by ZIP. These are residential USPS ZIPs
// for each county (PO-box-only and unique-business ZIPs omitted). 11385
// (Ridgewood) straddles Brooklyn/Queens and is assigned to Queens.
export const SERVICE_AREA_ZIPS: Record<County, readonly string[]> = {
  Kings: [
    "11201", "11203", "11204", "11205", "11206", "11207", "11208", "11209",
    "11210", "11211", "11212", "11213", "11214", "11215", "11216", "11217",
    "11218", "11219", "11220", "11221", "11222", "11223", "11224", "11225",
    "11226", "11228", "11229", "11230", "11231", "11232", "11233", "11234",
    "11235", "11236", "11237", "11238", "11239", "11249",
  ],
  Queens: [
    "11004", "11005", "11101", "11102", "11103", "11104", "11105", "11106",
    "11109", "11354", "11355", "11356", "11357", "11358", "11360", "11361",
    "11362", "11363", "11364", "11365", "11366", "11367", "11368", "11369",
    "11370", "11372", "11373", "11374", "11375", "11377", "11378", "11379",
    "11385", "11411", "11412", "11413", "11414", "11415", "11416", "11417",
    "11418", "11419", "11420", "11421", "11422", "11423", "11426", "11427",
    "11428", "11429", "11432", "11433", "11434", "11435", "11436", "11691",
    "11692", "11693", "11694", "11697",
  ],
  Richmond: [
    "10301", "10302", "10303", "10304", "10305", "10306", "10307", "10308",
    "10309", "10310", "10312", "10314",
  ],
};

/** True if the calendar date (month 1-based) falls inside `season`, which may wrap the new year. */
export function isInSeason(season: Season, month: number, day: number): boolean {
  const md = month * 100 + day;
  const start = season.start.month * 100 + season.start.day;
  const end = season.end.month * 100 + season.end.day;
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}

export function isHeatSeason(month: number, day: number): boolean {
  return isInSeason(BUSINESS.heatSeason, month, day);
}

export function isCoolingSeason(month: number, day: number): boolean {
  return isInSeason(BUSINESS.coolingSeason, month, day);
}
