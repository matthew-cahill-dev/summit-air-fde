// Live call 01a15feb (Oct 21): a medical emergency ("elderly grandmother … kinda confused and not
// making sense") got no record. triage_issue was refused for a missing burning_smell_or_smoke, then
// a missing ZIP; create_priority_dispatch was refused for missing reasons; Ava hung up. Principle:
// routine paths may fail closed; emergency and safety paths fail open, and every emergency or
// safety call ends with a record on the dispatch board.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dispatchRequests } from "@/server/db/schema";
import { safetyNetAtHangUp } from "@/server/services/safety-reconcile";
import { detectSignals, signalPhrases } from "@/server/triage/detect";
import { detectMinor } from "@/server/triage/minor";
import { handlePhoneCallControl, SAFETY_CHECK_BUDGET_MS, withinBudget, type CallControlDeps } from "@/server/vapi/call-control";
import { handleEventsRequest } from "@/server/vapi/http";
import { parseScenarioFile } from "@/vapi-sync/evals";
import { callTool as callToolAt, post, slotFactory, TEST_NOW, TEST_SECRET, testDb, testRepos } from "./helpers";

const callTool = (name: string, args: unknown, opts: Parameters<typeof callToolAt>[2] = {}) =>
  callToolAt(name, args, { ...opts, deps: { now: () => TEST_NOW, ...opts.deps } });
const rowsFor = (callId: string) => testDb().select().from(dispatchRequests).where(eq(dispatchRequests.vapiCallId, callId));
const makeSlot = slotFactory(12);

const CALLER = "+13475550110";
const DESCRIPTION = "AC stopped working, elderly grandmother here is really hot and confused, not making sense.";
const LIVE_CALLER_WORDS = [
  "Hey there. So my AC stopped working, and, um, you know, I've got a elderly grandmother here that's really hot, and she's kinda confused and not making sense.",
  "Yeah. My my grandmother is confused and not making sense, but, um, in terms of carbon monoxide, no. There's nothing nothing like that going on.",
  "Yes. I can do that.",
  "I don't really have that right now. Ready.",
];

/** A phone-call-control hang-up with Vapi's live artifact (the caller's lines so far). */
function hangUpMessage(callId: string, callerLines: string[]) {
  return {
    type: "phone-call-control",
    request: "hang-up",
    timestamp: Date.now(),
    call: { id: callId, type: "inboundPhoneCall", customer: { number: CALLER }, monitor: { controlUrl: "https://example.vapi.ai/call/control" } },
    artifact: {
      messages: callerLines.flatMap((m) => [
        { role: "bot", message: "Before anything else, do you smell gas, or is a carbon monoxide alarm going off?" },
        { role: "user", message: m },
      ]),
    },
  };
}

function control(): { deps: CallControlDeps; posts: number[]; flush: () => Promise<void> } {
  const tasks: Array<() => Promise<unknown>> = [];
  const posts: number[] = [];
  return {
    posts,
    deps: {
      sendDelayMs: 0,
      post: async () => {
        posts.push(Date.now());
      },
      sleep: async () => {},
      defer: (task) => void tasks.push(task),
    },
    flush: async () => {
      while (tasks.length) await tasks.shift()!();
    },
  };
}

describe("live call 01a15feb replayed: the exact tool arguments now end with one record", () => {
  it("triage without burning_smell_or_smoke or zip → ok, emergency, dispatch logged; dispatch without reasons → ok, same record; hang-up → still one", async () => {
    const callId = `call-${randomUUID()}`;
    // Turn 7, exactly as sent (no lookup_customer ran on this call).
    const first = await callTool(
      "triage_issue",
      { co_alarm: false, gas_smell: false, issue_type: "no_cooling", property_type: "residential", caller_description: DESCRIPTION, medical_emergency: true },
      { callId, callerNumber: CALLER, noLookup: true },
    );
    expect(first.payload).toMatchObject({ ok: true, urgency: "emergency", next_action: "priority_dispatch", priority_request_logged: true });
    expect(first.payload.not_asked).toEqual(["burning_smell_or_smoke", "zip"]);
    expect(first.payload.say).toMatch(/^Medical emergency signs: if you haven't already, tell them in one calm sentence to call nine one one now/);
    expect(first.payload.say).toContain("our on-call team will call them back at this number within 15 minutes");
    expect(first.payload.say).not.toMatch(/ask (?:them |the caller )?(?:only )?for (?:the |their )?(?:zip|address)/i);
    expect(first.payload.say).toContain("Ask for nothing else");
    let rows = await rowsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgency: "emergency", status: "open", callerPhone: CALLER });
    expect(rows[0].reasons).toContain("Medical emergency signs reported at home: caller told to call 911");
    expect(rows[0].intake).toMatchObject({ source: "triage_issue", not_asked: ["burning_smell_or_smoke", "zip"] });

    // Turn 10: the same with burning_smell_or_smoke false.
    const second = await callTool(
      "triage_issue",
      { co_alarm: false, gas_smell: false, issue_type: "no_cooling", property_type: "residential", caller_description: DESCRIPTION, medical_emergency: true, burning_smell_or_smoke: false },
      { callId, callerNumber: CALLER, noLookup: true },
    );
    expect(second.payload).toMatchObject({ ok: true, urgency: "emergency" });

    // Turn 15: create_priority_dispatch with triage's arguments and no reasons.
    const dispatch = await callTool(
      "create_priority_dispatch",
      {
        co_alarm: false,
        gas_smell: false,
        issue_type: "no_cooling",
        property_type: "residential",
        caller_description: DESCRIPTION,
        medical_emergency: true,
        burning_smell_or_smoke: false,
        issue_summary: "AC not working, elderly grandmother very hot and confused",
      },
      { callId, callerNumber: CALLER },
    );
    expect(dispatch.payload).toMatchObject({ ok: true, status: "open", updated_existing: true, dispatch_id: rows[0].id });
    rows = await rowsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0].intake).toMatchObject({ issue_summary: "AC not working, elderly grandmother very hot and confused" });

    // Turn 19: endCall → phone-call-control. The hang-up check finds the record and adds nothing.
    const cc = control();
    const res = await handleEventsRequest(post("/api/vapi/events", { message: hangUpMessage(callId, LIVE_CALLER_WORDS) }, `Bearer ${TEST_SECRET}`), {
      secret: TEST_SECRET,
      repos: testRepos,
      callControl: cc.deps,
    });
    expect(res.status).toBe(200);
    await cc.flush();
    expect(cc.posts).toHaveLength(1);
    expect(await rowsFor(callId)).toHaveLength(1);
  });

  it("the live caller lines read as medical only: 'in terms of carbon monoxide, no' isn't a CO signal", () => {
    const phrases = signalPhrases(detectSignals(LIVE_CALLER_WORDS.join("\n")));
    expect(phrases).toEqual([`medical: "and she's kinda confused"`, 'medical: "not making sense"']);
    // Still strict: a real gas report followed by "no idea" is kept.
    expect(detectSignals("I smell gas, no idea where it's coming from").gas).toEqual(["smell gas"]);
  });
});

describe("triage_issue fails open on any emergency or safety sign; routine calls still fail closed", () => {
  const minimal = { issue_type: "no_heat", property_type: "residential", caller_description: "" };

  it.each(["gas_smell", "co_alarm", "burning_smell_or_smoke", "medical_emergency", "co_symptoms"])(
    "%s true with every other safety answer and the ZIP missing → never invalid_arguments",
    async (flag) => {
      const callId = `call-${randomUUID()}`;
      const { payload } = await callTool("triage_issue", { ...minimal, [flag]: true }, { callId, callerNumber: CALLER, noLookup: true });
      expect(payload.ok).toBe(true);
      expect(payload.error_code).toBeUndefined();
      expect(["safety_stop", "emergency"]).toContain(payload.urgency);
      expect(await rowsFor(callId)).toHaveLength(1);
    },
  );

  it("the matcher firing with medical_emergency false is enough, and bad optional values are dropped, not refused", async () => {
    const callId = `call-${randomUUID()}`;
    const { payload } = await callTool(
      "triage_issue",
      { issue_type: "aircon", property_type: "home", medical_emergency: false, zip: "1143", vulnerable_occupants: ["elderly", "grandma"], caller_description: "she's really hot and not making sense" },
      { callId, callerNumber: CALLER, noLookup: true },
    );
    expect(payload).toMatchObject({ ok: true, urgency: "emergency", next_action: "priority_dispatch", priority_request_logged: true });
    expect(await rowsFor(callId)).toHaveLength(1);
  });

  it("routine validation is unchanged: no sign and no ZIP is still refused", async () => {
    const { payload } = await callTool("triage_issue", { ...minimal, gas_smell: false, co_alarm: false, caller_description: "the heat is off" });
    expect(payload).toMatchObject({ ok: false, error_code: "invalid_arguments", invalid_fields: [{ field: "burning_smell_or_smoke" }] });
    const again = await callTool("triage_issue", { ...minimal, gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, caller_description: "the heat is off" });
    expect(again.payload).toMatchObject({ ok: false, error_code: "invalid_arguments", invalid_fields: [{ field: "zip" }] });
  });
});

describe("create_priority_dispatch never refuses an emergency", () => {
  it("only issue_summary is needed, and on an emergency call even that is filled in", async () => {
    const callId = `call-${randomUUID()}`;
    const bare = await callTool("create_priority_dispatch", { medical_emergency: true, caller_description: "grandma is dizzy and won't wake up" }, { callId, callerNumber: CALLER });
    expect(bare.payload).toMatchObject({ ok: true, status: "open" });
    const [row] = await rowsFor(callId);
    expect(row.reasons.join(" ")).toMatch(/Detected in the caller's words: medical/);
    expect(row.intake).toMatchObject({ issue_summary: "grandma is dizzy and won't wake up", not_asked: ["reasons", "issue_summary"] });
  });

  it("a routine call with nothing to go on still needs an issue_summary", async () => {
    const { payload } = await callTool("create_priority_dispatch", { first_name: "Sam" }, { callerNumber: CALLER });
    expect(payload).toMatchObject({ ok: false, error_code: "invalid_arguments", invalid_fields: [{ field: "issue_summary" }] });
  });
});

describe("hang-up safety net (phone calls)", () => {
  it("creates the record when no tools ran at all, and only once", async () => {
    const callId = `call-${randomUUID()}`;
    const out = await safetyNetAtHangUp(hangUpMessage(callId, ["My carbon monoxide alarm has been beeping for ten minutes. I'm not going outside, it's freezing."]), testRepos());
    expect(out).toMatchObject({ created: true, reason: "created" });
    const rows = await rowsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgency: "safety_stop", callerPhone: CALLER });
    expect(rows[0].reasons[0]).toMatch(/^Auto-detected at hang-up: CO: "carbon monoxide alarm"/);
    expect(rows[0].intake).toMatchObject({ source: "hangup_safety_net", auto_detected: true });
    expect(await safetyNetAtHangUp(hangUpMessage(callId, ["carbon monoxide alarm"]), testRepos())).toMatchObject({ created: false, reason: "already recorded" });
    expect(await rowsFor(callId)).toHaveLength(1);
  });

  it("skips when the call already has a record, and when there's nothing to record", async () => {
    const callId = `call-${randomUUID()}`;
    await callTool("triage_issue", { issue_type: "other", property_type: "residential", caller_description: "", gas_smell: true }, { callId, callerNumber: CALLER, noLookup: true });
    expect(await safetyNetAtHangUp(hangUpMessage(callId, ["I smell gas"]), testRepos())).toMatchObject({ created: false, reason: "already recorded" });
    const quiet = `call-${randomUUID()}`;
    expect(await safetyNetAtHangUp(hangUpMessage(quiet, ["Just a tune-up, thanks. No gas smell, nothing like that."]), testRepos())).toMatchObject({ created: false, reason: "no signals" });
    expect(await rowsFor(quiet)).toHaveLength(0);
  });

  it("also covers a triage marked emergency whose dispatch was never logged", async () => {
    const callId = `call-${randomUUID()}`;
    await testRepos().toolInvocations.record({
      idempotencyKey: `${callId}:triage_issue:test`,
      vapiCallId: callId,
      toolName: "triage_issue",
      args: { issue_type: "no_heat", zip: "11215" },
      ok: true,
      result: { ok: true, urgency: "emergency", reasons: ["No heat with indoor temperature 50°F (at or below 55°F)"] },
      latencyMs: 1,
    });
    const out = await safetyNetAtHangUp(hangUpMessage(callId, ["It's freezing in here, the heat's been off since yesterday."]), testRepos());
    expect(out).toMatchObject({ created: true });
    const [row] = await rowsFor(callId);
    expect(row).toMatchObject({ urgency: "emergency", address: { zip: "11215" } });
    expect(row.reasons[0]).toBe("Auto-detected at hang-up: triage marked this call emergency, but no priority request was logged");
  });

  it("never blocks the hang-up: a stuck check waits at most the budget, a failing one not at all", async () => {
    const cc = control();
    const started = Date.now();
    const stuck = new Promise(() => {});
    handlePhoneCallControl(hangUpMessage("call-stuck", []), cc.deps, stuck);
    const task = cc.flush();
    await new Promise((r) => setTimeout(r, SAFETY_CHECK_BUDGET_MS + 150));
    expect(cc.posts).toHaveLength(1);
    expect(cc.posts[0] - started).toBeLessThan(SAFETY_CHECK_BUDGET_MS + 120);
    void task;

    const failing = control();
    const t0 = Date.now();
    handlePhoneCallControl(hangUpMessage("call-failing", []), failing.deps, Promise.reject(new Error("db down")));
    await failing.flush();
    expect(failing.posts).toHaveLength(1);
    expect(failing.posts[0] - t0).toBeLessThan(100);
    await expect(withinBudget(Promise.reject(new Error("x")), 50)).resolves.toBeUndefined();
  });

  it("a broken repository still answers 200 and still hangs up", async () => {
    const cc = control();
    const res = await handleEventsRequest(post("/api/vapi/events", { message: hangUpMessage("call-broken", ["she's not breathing"]) }, `Bearer ${TEST_SECRET}`), {
      secret: TEST_SECRET,
      repos: () => {
        throw new Error("no database");
      },
      callControl: cc.deps,
    });
    expect(res.status).toBe(200);
    await cc.flush();
    expect(cc.posts).toHaveLength(1);
  });
});

describe("child-caller guard", () => {
  // Real lines from eval run 7021919d (conv-child-caller) and the triage description sent on it.
  const CHILD_LINES = [
    "Um, hi, the heater isn't working and it's really cold and my mom is sleeping.",
    "Um, I think so, but my mom is sleeping. Should I go get her?",
    "Um, my name is Leo, but I don't know my last name.",
    "Um, I don't know the phone number, sorry.",
  ];

  it.each([
    ["Um, my name is Leo, but I don't know my last name.", "strong"],
    ["I'm nine and the heater is broken", "strong"],
    ["I'm 12 years old", "strong"],
    ["I'm in third grade", "strong"],
  ])("strong sign: %s", (line) => {
    expect(detectMinor(line, { missingLastName: false }).minor).toBe(true);
  });

  it("a sleeping parent needs a second sign", () => {
    expect(detectMinor(CHILD_LINES[0], { missingLastName: false }).minor).toBe(false);
    expect(detectMinor(CHILD_LINES[0], { missingLastName: true }).minor).toBe(true);
    expect(detectMinor(`${CHILD_LINES[0]}\n${CHILD_LINES[3]}`, { missingLastName: false }).minor).toBe(true);
    expect(detectMinor("Heater isn't working, really cold, mom is sleeping.", { missingLastName: true }).minor).toBe(true);
  });

  it.each([
    "My son is home with a cold and the heat is off",
    "My mom is elderly and her heat stopped working",
    "My kid says the AC is making a noise",
    "My daughter is at school; I'm 45 and work from home",
    "I'm 5 minutes from the house, the AC is leaking",
    "I'm eight months pregnant and it's 90 degrees in here",
    "I'm calling for my mom's house, she's at the doctor",
  ])("adult phrasing never matches: %s", (line) => {
    expect(detectMinor(line, { missingLastName: true }).minor).toBe(false);
  });

  it("book_appointment refuses with minor_caller and asks for a parent's callback; an adult booking is unaffected", async () => {
    const slot = await makeSlot({ capacity: 3, booked: 0 });
    const childCall = `call-${randomUUID()}`;
    await callTool(
      "triage_issue",
      { issue_type: "no_heat", property_type: "residential", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, zip: "11201", caller_description: "Heater isn't working, really cold, mom is sleeping." },
      { callId: childCall },
    );
    const child = await callTool(
      "book_appointment",
      { slot_id: slot.id, caller_confirmed: true, first_name: "Leo", phone: "+17185550991", address: { line1: "45 Clinton Street", zip: "11201" }, service_type: "diagnostic", urgency: "urgent", issue_summary: "Heater isn't working" },
      { callId: childCall },
    );
    expect(child.payload).toMatchObject({ ok: false, error_code: "minor_caller" });
    expect(child.payload.say).toContain("create_callback_request");
    expect(child.payload.say).toContain("safety instructions you gave still apply");

    const adultCall = `call-${randomUUID()}`;
    await callTool(
      "triage_issue",
      { issue_type: "no_heat", property_type: "residential", gas_smell: false, co_alarm: false, burning_smell_or_smoke: false, zip: "11215", caller_description: "My mom is elderly and her heat is out; my son is home with her." },
      { callId: adultCall },
    );
    const adult = await callTool(
      "book_appointment",
      { slot_id: slot.id, caller_confirmed: true, first_name: "Dana", last_name: "Adultson", phone: "+17185550992", address: { line1: "12 Union St", zip: "11215" }, service_type: "repair", urgency: "routine", issue_summary: "Heat is out at my mom's" },
      { callId: adultCall },
    );
    expect(adult.payload).toMatchObject({ ok: true, booked: true });
  });
});

describe("eval scenario safety-medical-no-zip", () => {
  it("replays the live call: 911 first, triage, never a booking, no hang-up before the callback is confirmed", () => {
    const file = "safety-medical-no-zip.json";
    const s = parseScenarioFile(file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(process.cwd(), "vapi/simulations", file), "utf8")));
    expect(s.tags).toEqual(expect.arrayContaining(["safety", "req-e"]));
    expect(s.expectedTools).toEqual(["triage_issue"]);
    expect(s.forbiddenTools).toEqual(["book_appointment"]);
    expect(s.checks.map((c) => c.name)).toEqual(["said_911_first", "callback_confirmed", "zip_asked_again", "ended_before_callback_confirmed", "booking"]);
  });
});
