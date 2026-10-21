import { describe, expect, it } from "vitest";
import { describeEnvelopeShape, parseToolArguments, parseToolCallsEnvelope } from "@/server/vapi/envelope";
import { toolCallsBody } from "./helpers";

describe("parseToolCallsEnvelope", () => {
  it("parses object arguments, call id and caller number", () => {
    const body = toolCallsBody({
      callId: "call-1",
      callerNumber: "+17185550101",
      calls: [{ id: "tc-1", name: "check_service_area", arguments: { zip: "11215" } }],
    });
    expect(parseToolCallsEnvelope(body)).toEqual({
      callId: "call-1",
      isSimulation: false,
      callerPhone: "+17185550101",
      toolCalls: [{ toolCallId: "tc-1", name: "check_service_area", args: { zip: "11215" }, argsError: undefined }],
      droppedWithoutId: 0,
    });
  });

  it("parses JSON-string arguments", () => {
    const body = toolCallsBody({
      callId: "call-2",
      calls: [{ id: "tc-2", name: "check_service_area", arguments: '{"zip":"11372","property_type":"residential"}' }],
    });
    const parsed = parseToolCallsEnvelope(body);
    expect(parsed?.toolCalls[0].args).toEqual({ zip: "11372", property_type: "residential" });
    expect(parsed?.callerPhone).toBeNull(); // caller number is optional
  });

  it("treats empty/missing arguments as {} and flags malformed JSON", () => {
    expect(parseToolArguments(undefined)).toEqual({ args: {} });
    expect(parseToolArguments("")).toEqual({ args: {} });
    expect(parseToolArguments("{not json")).toEqual({ args: null, error: "arguments is not valid JSON" });
    expect(parseToolArguments("[1,2]")).toEqual({ args: null, error: "arguments must be a JSON object" });
  });

  it("falls back to toolWithToolCallList and counts entries without ids", () => {
    const body = {
      message: {
        type: "tool-calls",
        call: { id: "call-3" },
        toolWithToolCallList: [
          { type: "function", toolCall: { id: "tc-3", function: { name: "lookup_customer", arguments: {} } } },
          { type: "function", toolCall: { function: { name: "lookup_customer", arguments: {} } } },
        ],
      },
    };
    const parsed = parseToolCallsEnvelope(body);
    expect(parsed?.toolCalls.map((t) => t.toolCallId)).toEqual(["tc-3"]);
    expect(parsed?.droppedWithoutId).toBe(1);
  });

  it("returns null for other message types", () => {
    expect(parseToolCallsEnvelope({ message: { type: "status-update" } })).toBeNull();
    expect(parseToolCallsEnvelope("nope")).toBeNull();
  });

  it("describes envelope shape with key names only", () => {
    const body = toolCallsBody({ callId: "c", callerNumber: "+17185550101", calls: [] });
    const shape = describeEnvelopeShape(body);
    expect(shape.topLevelKeys).toEqual(["message"]);
    expect(shape.messageType).toBe("tool-calls");
    expect(shape.hasCallerNumber).toBe(true);
    expect(JSON.stringify(shape)).not.toContain("5550101");
  });
});
