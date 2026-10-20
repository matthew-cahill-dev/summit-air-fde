import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalize a phone number to E.164, defaulting to US for national formats.
 * Returns null when the input isn't a valid number.
 */
export function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, "US");
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
