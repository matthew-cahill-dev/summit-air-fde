import { describe, expect, it } from "vitest";
import { canonicalJSON } from "@/server/lib/canonical-json";
import { idempotencyKey } from "@/server/vapi/dispatcher";

describe("canonicalJSON / idempotencyKey", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJSON({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it("builds callId:tool:sha256 keys", () => {
    const k1 = idempotencyKey("call-1", "lookup_customer", { phone: "1", z: 2 });
    const k2 = idempotencyKey("call-1", "lookup_customer", { z: 2, phone: "1" });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^call-1:lookup_customer:[0-9a-f]{64}$/);
    expect(idempotencyKey("call-2", "lookup_customer", { phone: "1", z: 2 })).not.toBe(k1);
  });
});
