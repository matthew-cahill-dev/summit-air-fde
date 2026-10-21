import { describe, expect, it } from "vitest";
import { z } from "zod";
import { blankToUndefined, optionalArg } from "@/server/lib/optional-arg";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
import { callTool, slotFactory, TEST_NOW } from "./helpers";

const makeSlot = slotFactory(2);

describe("optionalArg", () => {
  const schema = z.object({ notes: optionalArg(z.string().trim().min(1)), temp: optionalArg(z.number()) });

  it.each([[""], ["   "], [null], [undefined]])("%j counts as omitted", (blank) => {
    expect(schema.parse({ notes: blank, temp: blank })).toEqual({ notes: undefined, temp: undefined });
  });

  it("keeps real values and still validates them", () => {
    expect(schema.parse({ notes: " Buzzer 4R ", temp: 60 })).toEqual({ notes: "Buzzer 4R", temp: 60 });
    expect(schema.safeParse({ temp: "warm" }).success).toBe(false);
  });

  it("stays optional (not required) in the JSON schema sent to Vapi", () => {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { required?: string[]; properties: Record<string, unknown> };
    expect(json.required ?? []).toEqual([]);
    expect(json.properties.notes).toMatchObject({ type: "string" });
  });

  it("blankToUndefined leaves non-blank values alone", () => {
    expect(blankToUndefined(0)).toBe(0);
    expect(blankToUndefined(false)).toBe(false);
    expect(blankToUndefined("x")).toBe("x");
  });

  it("every optional field in every tool accepts \"\"", () => {
    let checked = 0;
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      const shape = (def.schema as unknown as { _zod: { def: { shape?: Record<string, z.ZodType> } } })._zod.def.shape;
      expect(shape, name).toBeDefined();
      for (const [key, field] of Object.entries(shape!)) {
        if (!field.safeParse(undefined).success || field.safeParse(undefined).data !== undefined) continue; // required or defaulted
        expect(field.safeParse("").success, `${name}.${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });
});

describe("tools treat blank optional fields as omitted (real DB)", () => {
  it("book_appointment with access_notes, equipment, email, unit and customer_id all \"\" books", async () => {
    const slot = await makeSlot({ capacity: 2, booked: 0 });
    const { payload } = await callTool(
      "book_appointment",
      {
        slot_id: slot.id,
        caller_confirmed: true,
        customer_id: "",
        address_id: "",
        first_name: "Avery",
        last_name: "Blankfield",
        phone: "",
        email: "",
        address: { line1: "77 Demo Pl", unit: "", city: "", zip: "11215" },
        service_type: "repair",
        urgency: "routine",
        issue_summary: "No heat upstairs",
        equipment: "",
        access_notes: "",
      },
      { callerNumber: "+17185550166", deps: { now: () => TEST_NOW } },
    );
    expect(payload).toMatchObject({ ok: true, booked: true });
  });

  it("lookup_customer with blank phone/zip/last_name falls back to caller ID", async () => {
    const { payload } = await callTool("lookup_customer", { phone: "", zip: "", last_name: "", street_address: "" }, { callerNumber: "+13475550102" });
    expect(payload).toMatchObject({ ok: true, found: true, verified: false, verification_required: true });
  });

  it("triage_issue with blank customer_id, preferred_window and indoor_temp_f", async () => {
    const { payload } = await callTool("triage_issue", {
      issue_type: "maintenance",
      gas_smell: false,
      co_alarm: false,
      burning_smell_or_smoke: false,
      property_type: "residential",
      zip: "11372",
      customer_id: "",
      preferred_window: "",
      indoor_temp_f: "",
    });
    expect(payload).toMatchObject({ ok: true, next_action: "book_standard" });
  });

  it("a blank REQUIRED field is still an error naming the field", async () => {
    const { payload } = await callTool("create_callback_request", { reason: "other", details: "" });
    expect(payload).toMatchObject({ ok: false, error_code: "invalid_arguments", invalid_fields: [{ field: "details" }] });
  });
});
