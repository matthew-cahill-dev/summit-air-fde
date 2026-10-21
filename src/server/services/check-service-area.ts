import { z } from "zod";
import { BUSINESS, coverageOf } from "@/config/business";
import { optionalArg } from "@/server/lib/optional-arg";
import { defineTool, type ToolOutcome } from "@/server/vapi/types";

export const checkServiceAreaSchema = z.object({
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "must be a 5-digit ZIP code")
    .transform((z) => z.slice(0, 5)),
  property_type: optionalArg(z.enum(["residential", "commercial"])),
});

type PropertyType = "residential" | "commercial";

/** Pure: decide serviceability from the ZIP row (or its absence) and property type. */
export function evaluateServiceArea(
  zip: string,
  zipRow: { county: string; active: boolean } | null,
  propertyType: PropertyType,
  residentialOnly: boolean = BUSINESS.residentialOnly,
): ToolOutcome {
  const cov = coverageOf(zipRow);
  const inArea = cov.coverage === "in_area";
  const county = inArea ? cov.county : null;
  const base = { zip, in_area: inArea, coverage: cov.coverage, county };

  if (propertyType === "commercial" && residentialOnly) {
    return {
      ok: true,
      data: { ...base, serviceable: false, reason: "residential_only" },
      say: "Politely explain Summit Air only services residential homes, so we can't help with a commercial property. Next: thank them and end the call.",
    };
  }
  if (cov.coverage === "coverage_check") {
    return {
      ok: true,
      data: { ...base, serviceable: false, reason: "coverage_unconfirmed", borough: cov.borough },
      say:
        `Don't book or offer times. Say: "Let me have our office confirm whether we can cover that address." Don't give a reason or say we don't serve it. ` +
        "Next: this check doesn't replace triage. If you haven't yet, ask the safety question, call lookup_customer and ask what's going on; then call triage_issue, which gives the coverage-check callback details for create_callback_request.",
    };
  }
  if (!inArea) {
    return {
      ok: true,
      data: { ...base, serviceable: false, reason: "out_of_area" },
      say: `Explain that this ZIP is outside our service area (homes in ${BUSINESS.facts.serviceArea}). Next: double-check the ZIP with the caller; if it was misheard, check again with the corrected one.`,
    };
  }
  return {
    ok: true,
    data: { ...base, serviceable: true },
    say: `This address is in our ${county} County service area. Next: if you haven't yet, ask the safety question, call lookup_customer and ask what's going on; then call triage_issue.`,
  };
}

export const checkServiceAreaTool = defineTool({
  schema: checkServiceAreaSchema,
  async handler(args, ctx) {
    const row = await ctx.repos.serviceArea.findZip(args.zip);
    return evaluateServiceArea(args.zip, row, args.property_type ?? "residential");
  },
});
