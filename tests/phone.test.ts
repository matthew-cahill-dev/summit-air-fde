import { describe, expect, it } from "vitest";
import { normalizePhoneE164 } from "@/server/lib/phone";

describe("normalizePhoneE164", () => {
  it.each([
    ["(718) 555-0101", "+17185550101"],
    ["718-555-0101", "+17185550101"],
    ["7185550101", "+17185550101"],
    ["1 718 555 0101", "+17185550101"],
    ["+1 (347) 555-0102", "+13475550102"],
    ["  917.555.0104  ", "+19175550104"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
  });

  it.each([["555-0101"], ["abc"], [""], ["123"]])("rejects %j", (input) => {
    expect(normalizePhoneE164(input)).toBeNull();
  });

  it("handles null/undefined", () => {
    expect(normalizePhoneE164(null)).toBeNull();
    expect(normalizePhoneE164(undefined)).toBeNull();
  });
});
