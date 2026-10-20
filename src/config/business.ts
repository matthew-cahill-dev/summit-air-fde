// Summit Air business configuration.
// Everything here is an ASSUMPTION for the demo until confirmed with the business.
// Keep this file free of path aliases: it is also compiled for the seed script.

export type County = "Kings" | "Queens" | "Richmond";

export const BUSINESS = {
  name: "Summit Air",

  // ASSUMPTION: residential customers only; commercial properties are declined.
  residentialOnly: true,

  // ASSUMPTION: heat season runs Oct 1 through May 31 (NYC heat season).
  // Month is 1-based.
  heatSeason: {
    start: { month: 10, day: 1 },
    end: { month: 5, day: 31 },
  },

  // ASSUMPTION: a priority-dispatch request gets a human callback within 15 minutes.
  priorityDispatchCallbackSlaMinutes: 15,

  // ASSUMPTION: we serve Brooklyn (Kings), Queens and Staten Island (Richmond).
  serviceCounties: ["Kings", "Queens", "Richmond"] as const satisfies readonly County[],
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

/** True if `date` (a calendar date in the business time zone) falls in heat season. */
export function isHeatSeason(month: number, day: number): boolean {
  const { start, end } = BUSINESS.heatSeason;
  const md = month * 100 + day;
  return md >= start.month * 100 + start.day || md <= end.month * 100 + end.day;
}
