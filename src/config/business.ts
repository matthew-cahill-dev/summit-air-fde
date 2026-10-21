// Summit Air business configuration.
// Everything here is an ASSUMPTION for the demo until confirmed with the business.
// Keep this file free of path aliases: it is also compiled for the seed script.

/** NYC counties (boroughs) we know ZIPs for. Which are served is BUSINESS.serviceCounties. */
export type County = "Kings" | "Queens" | "New York" | "Bronx" | "Richmond";

/** How callers say each county. */
export const BOROUGH: Record<County, string> = {
  Kings: "Brooklyn",
  Queens: "Queens",
  "New York": "Manhattan",
  Bronx: "Bronx",
  Richmond: "Staten Island",
};

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

  // ASSUMPTION (owner to confirm): Summit Air does NOT refer commercial callers to other
  // companies. false: decline ("we only service homes"), suggest a commercial HVAC company,
  // end the call, no callback. true: offer an office callback with referrals.
  commercialReferrals: false,

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

  // ASSUMPTION (owner to confirm): Summit Air said "three counties" without naming them. We assume
  // Kings (Brooklyn), Queens and New York (Manhattan): NYC's three most populous boroughs, and where
  // Revin's Manhattan-based reviewers will naturally test. Confirming the real three is a one-line
  // change here plus `npm run db:seed` (which re-flags the ZIP table).
  serviceCounties: ["Kings", "Queens", "New York"] as const satisfies readonly County[],

  // ASSUMPTION: NYC boroughs we neither serve nor rule out. Calls there never book; triage returns
  // office_review and Ava says the office will confirm coverage (a "coverage check" callback).
  coverageCheckCounties: ["Bronx", "Richmond"] as const satisfies readonly County[],

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
    serviceArea: "Brooklyn, Queens and Manhattan",
  },
} as const;

// ASSUMPTION: the service area is defined by ZIP. These are the residential USPS ZIPs for each NYC
// county (PO-box-only and unique-business ZIPs omitted). 11385 (Ridgewood) straddles
// Brooklyn/Queens and is assigned to Queens. The seed marks a county's ZIPs active (in area) when
// the county is in BUSINESS.serviceCounties; Bronx and Staten Island ZIPs are stored inactive and
// mean "coverage check"; any ZIP not listed here is out of area.
export const NYC_ZIPS: Record<County, readonly string[]> = {
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
  "New York": [
    "10001", "10002", "10003", "10004", "10005", "10006", "10007", "10009",
    "10010", "10011", "10012", "10013", "10014", "10016", "10017", "10018",
    "10019", "10021", "10022", "10023", "10024", "10025", "10026", "10027",
    "10028", "10029", "10030", "10031", "10032", "10033", "10034", "10035",
    "10036", "10037", "10038", "10039", "10040", "10044", "10065", "10069",
    "10075", "10128", "10280", "10282",
  ],
  Bronx: [
    "10451", "10452", "10453", "10454", "10455", "10456", "10457", "10458",
    "10459", "10460", "10461", "10462", "10463", "10464", "10465", "10466",
    "10467", "10468", "10469", "10470", "10471", "10472", "10473", "10474",
    "10475",
  ],
  Richmond: [
    "10301", "10302", "10303", "10304", "10305", "10306", "10307", "10308",
    "10309", "10310", "10312", "10314",
  ],
};

/** True if the calendar date (month 1-based) falls inside `season`, which may wrap the new year. */
export type Coverage = "in_area" | "coverage_check" | "out_of_area";

/**
 * Coverage for a ZIP row from service_area_zips (or null when the ZIP isn't stored): in area
 * (active), a coverage check (a known NYC borough we neither serve nor rule out), or out of area.
 */
export function coverageOf(row: { county: string; active: boolean } | null): { coverage: Coverage; county: string | null; borough: string | null } {
  if (!row) return { coverage: "out_of_area", county: null, borough: null };
  const borough = row.county in BOROUGH ? BOROUGH[row.county as County] : null;
  if (row.active) return { coverage: "in_area", county: row.county, borough };
  if ((BUSINESS.coverageCheckCounties as readonly string[]).includes(row.county)) return { coverage: "coverage_check", county: row.county, borough };
  return { coverage: "out_of_area", county: row.county, borough };
}

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
