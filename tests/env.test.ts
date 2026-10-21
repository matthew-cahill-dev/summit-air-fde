import { afterEach, describe, expect, it } from "vitest";
import { getEnv, parseDemoCallerPhones, resetEnvCacheForTests } from "@/lib/env";

describe("parseDemoCallerPhones", () => {
  it("parses phone=uuid pairs to E.164", () => {
    const map = parseDemoCallerPhones(" (202) 555-0100=00000000-0000-4000-8000-000000000005 , +1 202 555 0101=00000000-0000-4000-8000-000000000001");
    expect([...map]).toEqual([
      ["+12025550100", "00000000-0000-4000-8000-000000000005"],
      ["+12025550101", "00000000-0000-4000-8000-000000000001"],
    ]);
  });

  it("empty is an empty map", () => {
    expect(parseDemoCallerPhones(undefined).size).toBe(0);
    expect(parseDemoCallerPhones("  ").size).toBe(0);
  });

  it.each([["+12025550100"], ["+12025550100=not-a-uuid"], ["555=00000000-0000-4000-8000-000000000005"]])("rejects %j without echoing it", (raw) => {
    expect(() => parseDemoCallerPhones(raw)).toThrow("each entry must be <phone>=<customer uuid>");
  });
});

describe("getEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCacheForTests();
  });

  it("invalid DEMO_CALLER_PHONES fails boot without leaking the number", () => {
    process.env.DEMO_CALLER_PHONES = "+12025550100=bad";
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/DEMO_CALLER_PHONES: each entry/);
    try {
      getEnv();
    } catch (err) {
      expect(String(err)).not.toContain("2025550100");
    }
  });

  it("assistant-request flag defaults off", () => {
    delete process.env.ASSISTANT_REQUEST_ENABLED;
    resetEnvCacheForTests();
    expect(getEnv().ASSISTANT_REQUEST_ENABLED).toBe(false);
    process.env.ASSISTANT_REQUEST_ENABLED = "true";
    resetEnvCacheForTests();
    expect(getEnv().ASSISTANT_REQUEST_ENABLED).toBe(true);
  });
});
