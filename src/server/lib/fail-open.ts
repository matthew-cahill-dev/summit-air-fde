// Emergency and safety paths fail open (live call 01a15feb: triage refused a medical emergency for a
// missing smoke flag, then a missing ZIP; the dispatch was refused for missing reasons; the call
// ended with no record). These helpers repair arguments field by field instead of refusing them.
import type { z } from "zod";

/** Keeps each argument its own schema accepts and drops the rest. Unknown keys pass through. */
export function keepValid(shape: Record<string, z.ZodType>, raw: Record<string, unknown>): { args: Record<string, unknown>; dropped: string[] } {
  const args: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in shape) || shape[k].safeParse(v).success) args[k] = v;
    else dropped.push(k);
  }
  return { args, dropped };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A nested object (e.g. an address) repaired the same way; null when nothing usable is left. */
export function keepValidObject(shape: Record<string, z.ZodType>, raw: unknown, path: string): { value: Record<string, unknown> | null; dropped: string[] } {
  if (!isObj(raw)) return { value: null, dropped: raw === undefined || raw === null || raw === "" ? [] : [path] };
  const { args, dropped } = keepValid(shape, raw);
  const known = Object.fromEntries(Object.entries(args).filter(([k]) => k in shape));
  return { value: Object.keys(known).length ? known : null, dropped: dropped.map((d) => `${path}.${d}`) };
}
