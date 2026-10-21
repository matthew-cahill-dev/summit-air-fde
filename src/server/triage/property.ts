// What kind of property a call is about, from triage_issue's arguments. Pure.
// Shown in the console (call header, board cards) and as the first sentence of
// technician notes.

export type PropertyKind = "residential" | "commercial" | "multi_unit";

export const PROPERTY_LABEL: Record<PropertyKind, string> = {
  residential: "Residential",
  commercial: "Commercial",
  multi_unit: "Multi-unit",
};

/** A building-wide system wins over the property type; null when triage didn't say. */
export function propertyKind(args: unknown): PropertyKind | null {
  if (typeof args !== "object" || args === null) return null;
  const a = args as Record<string, unknown>;
  if (a.multi_unit_central_system === true) return "multi_unit";
  if (a.property_type === "commercial") return "commercial";
  if (a.property_type === "residential") return "residential";
  return null;
}
