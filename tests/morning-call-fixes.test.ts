// Fixes from live call 01a15e9b (Oct 21, 2026 morning): one outcome per call, exact arrival
// times as notes, tool-overhead measurement, ending timing from Vapi's call log.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { appointments, appointmentSlots } from "@/server/db/schema";
import { mergeIntake } from "@/server/services/book-appointment";
import { requestTiming } from "@/server/vapi/http";
import { analyzeLog, type LogRow } from "@/vapi-sync/call-report";
import { callTool as callToolAt, slotFactory, TEST_NOW, testDb } from "./helpers";
import { testDatabaseUrl } from "./test-db-url";

const makeSlot = slotFactory(6);
const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });

const booking = (slotId: string, over: Record<string, unknown> = {}) => ({
  slot_id: slotId,
  caller_confirmed: true,
  first_name: "Priya",
  last_name: "Tester",
  address: { line1: "61 Morning Ave", zip: "11215" },
  service_type: "repair",
  urgency: "urgent",
  issue_summary: "AC not cooling, grandmother at home",
  symptoms: ["blowing warm air"],
  vulnerable_occupants: ["elderly"],
  ...over,
});

describe("exact arrival times are a note, never a callback (live: '8:30' became a callback)", () => {
  it("arrival_preference goes into the intake and the technician notes", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const { payload } = await callTool("book_appointment", booking(slot.id, { arrival_preference: "around 8:30 AM" }), { callerNumber: "+17185550701" });
    expect(payload).toMatchObject({ ok: true, booked: true, details_updated: false });
    const [appt] = await testDb().select().from(appointments).where(eq(appointments.id, payload.appointment_id as string));
    expect(appt.intake).toMatchObject({ arrival_preference: "around 8:30 AM" });
    expect(appt.technicianNotes).toContain("Arrival preference: around 8:30 AM if possible (inside the booked window; not promised");
  });

  it("asking after booking: the same window again updates that appointment, no second booking, no seat taken", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    const first = await callTool("book_appointment", booking(slot.id, { pets: "a dog" }), { callId, callerNumber: "+17185550702" });
    expect(first.payload).toMatchObject({ ok: true, already_booked: false });

    // The model re-sends with fewer details plus the new preference: nothing already stored is lost.
    const again = await callTool(
      "book_appointment",
      booking(slot.id, { symptoms: ["clicking"], arrival_preference: "8:30" }),
      { callId, callerNumber: "+17185550702" },
    );
    expect(again.payload).toMatchObject({ ok: true, already_booked: true, details_updated: true, appointment_id: first.payload.appointment_id });
    expect(again.payload.say).toMatch(/no second appointment/);
    expect(again.payload.say).toMatch(/No callback is needed/);

    const rows = await testDb().select().from(appointments).where(eq(appointments.slotId, slot.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].intake).toMatchObject({ pets: "a dog", arrival_preference: "8:30", symptoms: ["blowing warm air", "clicking"] });
    expect(rows[0].technicianNotes).toContain("Pets: a dog.");
    expect(rows[0].technicianNotes).toContain("Arrival preference: 8:30 if possible");
    const [{ booked }] = await testDb().select({ booked: appointmentSlots.booked }).from(appointmentSlots).where(eq(appointmentSlots.id, slot.id));
    expect(booked).toBe(1);

    // A plain replay (same args, new call) changes nothing.
    const replay = await callTool("book_appointment", booking(slot.id, { symptoms: ["clicking"], arrival_preference: "8:30" }), { callerNumber: "+17185550702" });
    expect(replay.payload).toMatchObject({ already_booked: true, details_updated: false });
  });

  it("mergeIntake: new values win, lists combine, blanks keep what's stored", () => {
    expect(mergeIntake({ a: "x", list: [1], keep: "k" }, { a: "y", list: [1, 2], keep: "", none: null, empty: [] })).toEqual({ a: "y", list: [1, 2], keep: "k" });
    expect(mergeIntake(null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("one outcome per call (live: a callback AND a booking on one call)", () => {
  it("a callback on a call that already booked is flagged so the caller hears what it's for", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const callId = `call-${randomUUID()}`;
    await callTool("book_appointment", booking(slot.id), { callId, callerNumber: "+17185550703" });
    const { payload } = await callTool("create_callback_request", { reason: "other", details: "Wants a quote for a new system" }, { callId, callerNumber: "+17185550703" });
    expect(payload).toMatchObject({ ok: true, call_has_booking: true });
    expect(payload.say).toMatch(/already has a confirmed booking/);

    const fresh = await callTool("create_callback_request", { reason: "human_requested", details: "Wants a person" }, { callerNumber: "+17185550704" });
    expect(fresh.payload).toMatchObject({ ok: true, call_has_booking: false });
    expect(fresh.payload.say).not.toMatch(/already has a confirmed booking/);
  });
});

describe("tool overhead: our request timing vs Vapi's", () => {
  it("logs when the request arrived, Vapi's send time, the inbound delay and our total time", () => {
    const sent = Date.UTC(2026, 9, 21, 13, 17, 21, 0);
    const t = requestTiming({ message: { type: "tool-calls", timestamp: sent, call: { id: "call-1" } } }, sent + 412, performance.now() - 87);
    expect(t).toMatchObject({ callId: "call-1", inbound_ms: 412, vapi_sent_at: new Date(sent).toISOString(), received_at: new Date(sent + 412).toISOString() });
    expect(t.request_ms).toBeGreaterThanOrEqual(87);
    expect(requestTiming({}, sent, performance.now())).toMatchObject({ callId: null, vapi_sent_at: null, inbound_ms: null });
  });

  it("DB connections stay open between tool calls (measured: +215 ms reconnect after 30 s idle)", async () => {
    const { pool } = createDb(testDatabaseUrl());
    try {
      expect(pool.options.idleTimeoutMillis).toBe(600_000);
      expect(pool.options.keepAlive).toBe(true);
      expect(pool.listenerCount("error")).toBe(1); // an idle disconnect can't crash the process
    } finally {
      await pool.end();
    }
  });
});

describe("call-report reads Vapi's call log (webhook latency and real hang-up timing)", () => {
  // Shapes and times from the real log of call 01a15e9b (relative ms).
  const T = 1_792_588_846_000;
  const row = (dt: number, event: string, attributes: Record<string, unknown> = {}): LogRow => ({ time: T + dt, body: event, attributes: { event, ...attributes } });
  const rows: LogRow[] = [
    row(0, "assistant.tool.started", { toolNames: ["lookup_customer"] }),
    row(300, "pipeline.botSpeechStarted"),
    row(993, "serverMessage.requestSucceeded", { messageType: "tool-calls", latencyMs: 984, statusCode: 200, url: "https://x/api/vapi/tools" }),
    row(1559, "pipeline.botSpeechStopped"),
    row(1560, "assistant.tool.completed"),
    row(200_000, "assistant.tool.started", { toolNames: ["endCall"] }),
    row(200_266, "pipeline.botSpeechStarted"),
    row(203_435, "pipeline.botSpeechStopped"),
    row(203_437, "assistant.tool.completed"),
    row(203_439, "call.ended"),
    row(204_000, "serverMessage.requestSucceeded", { messageType: "phone-call-control", latencyMs: 560, statusCode: 200 }),
    row(206_542, "assistant.transcriber.cleanup"),
  ];

  it("splits a tool's time into the webhook and the filler, and measures the silent tail", () => {
    const a = analyzeLog(rows);
    expect(a.tools[0]).toEqual({ names: ["lookup_customer"], totalMs: 1560, webhookMs: 984, fillerStartMs: 300, fillerStopMs: 1559 });
    expect(a.ending).toEqual({ goodbyeStartMs: 266, goodbyeDurationMs: 3169, hangupAckAfterGoodbyeMs: 565, silentTailMs: 3107 });
    expect(a.webhooks.map((w) => w.messageType)).toEqual(["tool-calls", "phone-call-control"]);
  });

  it("copes with an empty or partial log", () => {
    expect(analyzeLog([])).toEqual({ webhooks: [], tools: [], ending: null });
    const partial = analyzeLog([row(0, "assistant.tool.started", { toolNames: ["endCall"] })]);
    expect(partial.ending).toEqual({ goodbyeStartMs: null, goodbyeDurationMs: null, hangupAckAfterGoodbyeMs: null, silentTailMs: null });
  });
});
