import { z } from "zod";

/** "" or whitespace-only (and null) mean "not provided": models often send them for fields they don't have. */
export function blankToUndefined(value: unknown): unknown {
  return value === null || (typeof value === "string" && value.trim() === "") ? undefined : value;
}

/**
 * An optional tool argument where a blank value counts as omitted, so access_notes: ""
 * doesn't fail with "Too small". The outer .optional() keeps the key optional in the
 * JSON schema sent to Vapi; the inner one accepts the undefined the preprocess produces.
 */
export function optionalArg<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema.optional()).optional();
}
