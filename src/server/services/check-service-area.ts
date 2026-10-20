import { z } from "zod";
import { BUSINESS } from "@/config/business";
import { defineTool, type ToolOutcome } from "@/server/vapi/types";

export const checkServiceAreaSchema = z.object({
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "must be a 5-digit ZIP code")
    .transform((z) => z.slice(0, 5)),
  property_type: z.enum(["residential", "commercial"]).optional(),
});

type PropertyType = "residential" | "commercial";

/** Pure: decide serviceability from the ZIP row (or its absence) and property type. */
export function evaluateServiceArea(
  zip: string,
  zipRow: { county: string; active: boolean } | null,
  propertyType: PropertyType,
  residentialOnly: boolean = BUSINESS.residentialOnly,
): ToolOutcome {
  const inArea = Boolean(zipRow?.active);
  const county = inArea ? zipRow!.county : null;
  const base = { zip, in_area: inArea, county };

  if (propertyType === "commercial" && residentialOnly) {
    return {
      ok: true,
      data: { ...base, serviceable: false, reason: "residential_only" },
      say: "Politely explain Summit Air only services residential homes, so we can't help with a commercial property.",
    };
  }
  if (!inArea) {
    return {
      ok: true,
      data: { ...base, serviceable: false, reason: "out_of_area" },
      say: "Explain that this ZIP is outside our service area (Brooklyn, Queens and Staten Island). Double-check the ZIP with the caller before ending.",
    };
  }
  return {
    ok: true,
    data: { ...base, serviceable: true },
    say: `This address is in our ${county} County service area.`,
  };
}

export const checkServiceAreaTool = defineTool({
  schema: checkServiceAreaSchema,
  async handler(args, ctx) {
    const row = await ctx.repos.serviceArea.findZip(args.zip);
    return evaluateServiceArea(args.zip, row, args.property_type ?? "residential");
  },
});
