// "What happened" on a call: each tool call as a plain-language step ("Verified returning member",
// "Triaged: urgent · elderly occupant", "Booked Thu Oct 22, 8–10 AM"), plus the transcript with
// those steps placed where they happened. Pure, so every wording is unit-tested.
import type { Tone } from "@/components/console/tone";
import type { InvocationRow, TranscriptMessage, Urgency } from "@/server/repositories";
import { isUrgency, safetyTriggerLabel, URGENCY_LABEL, vulnerableLabel } from "./format";

export type StepIcon = "user" | "triage" | "calendar" | "siren" | "phone" | "map" | "shield" | "alert" | "transfer" | "tool";

export type CallStep = {
  id: string;
  at: Date;
  tool: string;
  ok: boolean;
  title: string;
  detail: string | null;
  tone: Tone;
  icon: StepIcon;
  chips: Array<[string, string]>;
  latencyMs: number;
  dbMs: number | null;
};

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const URGENCY_TONE: Record<Urgency, Tone> = { safety_stop: "safety", emergency: "emergency", urgent: "urgent", routine: "routine" };

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "tomorrow, Thursday, October 22, between 8 and 10 AM" → "Thu Oct 22, 8–10 AM". Unknown shapes pass through. */
export function shortWindow(label: string): string {
  const m = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+between\s+(.+?)\s+and\s+(.+)$/.exec(label);
  if (!m || !DAYS.includes(m[1])) return label;
  return `${m[1].slice(0, 3)} ${m[2].slice(0, 3)} ${m[3]}, ${m[4]}–${m[5]}`;
}

const HIDDEN_ARGS = new Set(["customer_id", "address_id", "slot_id", "caller_confirmed", "gas_smell", "co_alarm", "burning_smell_or_smoke", "after"]);

/** Up to `max` short argument chips; ids and false flags are noise for an operator. */
export function stepChips(args: Obj | null, max = 4): Array<[string, string]> {
  if (!args) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(args)) {
    if (out.length >= max) break;
    if (HIDDEN_ARGS.has(k) || v === null || v === undefined || v === "" || v === false) continue;
    const key = k.replace(/_/g, " ");
    if (Array.isArray(v)) {
      if (v.length) out.push([key, v.map((x) => (typeof x === "string" ? x.replace(/_/g, " ") : String(x))).join(", ")]);
    } else if (typeof v === "object") {
      const parts = Object.values(v as Obj).filter((x): x is string => typeof x === "string" && x.trim() !== "");
      if (parts.length) out.push([key, parts.join(", ")]);
    } else if (v === true) {
      out.push([key, "yes"]);
    } else {
      out.push([key, String(v).replace(/_/g, " ")]);
    }
  }
  return out;
}

type Described = Pick<CallStep, "title" | "detail" | "tone" | "icon">;

function describeLookup(r: Obj): Described {
  if (r.verified === true) {
    const name = str(r.first_name);
    return {
      title: r.is_member === true ? "Verified returning member" : "Verified returning customer",
      detail: name ? `${name}${r.is_member === true ? " · active Comfort Club member" : ""}` : null,
      tone: "booked",
      icon: "user",
    };
  }
  if (r.verification_required === true) return { title: "Caller ID matched an account", detail: "Asked for the street to verify", tone: "neutral", icon: "user" };
  if (r.verification_locked === true) return { title: "Verification locked", detail: "Too many tries; continued as a new caller", tone: "neutral", icon: "shield" };
  if (r.verification_failed === true) return { title: "Couldn't verify the address", detail: null, tone: "neutral", icon: "user" };
  if (r.caller_id_unavailable === true) return { title: "No caller ID", detail: "Asked whether they're an existing customer", tone: "neutral", icon: "user" };
  if (r.ambiguous === true) return { title: "Needs more to verify", detail: null, tone: "neutral", icon: "user" };
  return { title: "New caller", detail: "No account for this number", tone: "neutral", icon: "user" };
}

function describeTriage(args: Obj | null, r: Obj): Described {
  const urgency = isUrgency(r.urgency) ? r.urgency : null;
  if (r.next_action === "safety_instructions" || urgency === "safety_stop") {
    const trigger = safetyTriggerLabel(args, r.reasons) ?? (args?.co_symptoms === true ? "CO symptoms" : "Safety concern");
    return { title: `Safety stop: ${trigger.toLowerCase()}`, detail: "Safety instructions given; office follow-up logged", tone: "safety", icon: "alert" };
  }
  if (r.coverage_check === true || r.not_serviceable_reason === "coverage_unconfirmed") {
    return { title: `Office coverage check${str(r.borough) ? ` · ${str(r.borough)}` : ""}`, detail: "Not booked; the office confirms coverage", tone: "coverage", icon: "map" };
  }
  if (r.not_serviceable_reason === "residential_only") return { title: "Commercial property: declined", detail: "Summit Air services homes only", tone: "neutral", icon: "map" };
  if (r.not_serviceable_reason === "out_of_area") return { title: "Outside the service area", detail: str(args?.zip) ? `ZIP ${str(args?.zip)}` : null, tone: "neutral", icon: "map" };
  if (r.next_action === "office_review") return { title: "Building-wide system: office review", detail: null, tone: "callback", icon: "triage" };
  const vulnerable = arr(args?.vulnerable_occupants).filter((v): v is string => typeof v === "string");
  const why = vulnerable.length
    ? `${vulnerable.map((v) => vulnerableLabel(v).toLowerCase()).join(", ")} occupant`
    : (arr(r.reasons).find((x): x is string => typeof x === "string") ?? null);
  const offered = arr(r.offered_slots).length;
  return {
    title: `Triaged: ${urgency ? URGENCY_LABEL[urgency].toLowerCase() : "assessed"}${why ? ` · ${why}` : ""}`,
    detail: r.next_action === "priority_dispatch" ? "Priority dispatch required" : offered ? `Offered ${offered} window${offered === 1 ? "" : "s"}` : null,
    tone: urgency ? URGENCY_TONE[urgency] : "neutral",
    icon: "triage",
  };
}

function describeBooking(r: Obj): Described {
  const window = str(r.window) ? shortWindow(str(r.window)!) : null;
  if (r.changed_window === true) return { title: `Moved booking to ${window ?? "a new window"}`, detail: "Earlier window released", tone: "booked", icon: "calendar" };
  if (r.details_updated === true) return { title: "Added details to the booking", detail: window, tone: "booked", icon: "calendar" };
  if (r.already_booked === true) return { title: `Booking confirmed${window ? ` · ${window}` : ""}`, detail: null, tone: "booked", icon: "calendar" };
  const code = str(r.confirmation_code);
  return { title: `Booked ${window ?? ""}`.trim(), detail: code ? `Confirmation ${code}` : null, tone: "booked", icon: "calendar" };
}

function describeCallback(args: Obj | null, r: Obj): Described {
  const details = str(args?.details) ?? "";
  if (/^coverage check/i.test(details)) {
    const borough = /^coverage check:?\s*([^,.]+)/i.exec(details)?.[1]?.trim();
    return { title: `Office coverage check${borough ? ` · ${borough}` : ""}`, detail: "Office will confirm and call back", tone: "coverage", icon: "map" };
  }
  const reason = str(args?.reason);
  const label = reason === "human_requested" ? "asked for a person" : reason === "backend_failure" ? "system trouble" : null;
  return {
    title: r.updated === true ? "Callback request updated" : `Callback requested${label ? ` · ${label}` : ""}`,
    detail: details ? details.slice(0, 120) : null,
    tone: "callback",
    icon: "phone",
  };
}

function describeError(tool: string, r: Obj): Described {
  const code = str(r.error_code) ?? "error";
  if (code === "lookup_required") return { title: "Waited for the account lookup", detail: "Membership is checked first", tone: "neutral", icon: "shield" };
  if (code === "slot_taken") return { title: "Window just taken", detail: "Offered the alternatives", tone: "urgent", icon: "calendar" };
  if (code === "coverage_check") return { title: "Office coverage check", detail: "Not bookable until the office confirms", tone: "coverage", icon: "map" };
  if (code === "invalid_arguments") return { title: `${tool.replace(/_/g, " ")}: needed more details`, detail: str(r.message), tone: "neutral", icon: "tool" };
  return { title: `${tool.replace(/_/g, " ")} failed`, detail: str(r.message) ?? code, tone: "safety", icon: "alert" };
}

export function describeInvocation(inv: Pick<InvocationRow, "toolName" | "ok" | "args" | "result">): Described {
  const r = inv.result as Obj;
  if (!inv.ok) return describeError(inv.toolName, r);
  switch (inv.toolName) {
    case "lookup_customer":
      return describeLookup(r);
    case "triage_issue":
      return describeTriage(inv.args as Obj | null, r);
    case "get_availability": {
      const n = arr(r.offered_slots).length;
      const note = r.scheduling_note === "weekdays_only" ? "Weekdays only" : r.scheduling_note === "beyond_booking_horizon" ? "Beyond the two-week window" : null;
      return { title: n ? `Offered ${n} more window${n === 1 ? "" : "s"}` : "No more windows open", detail: note, tone: "routine", icon: "calendar" };
    }
    case "book_appointment":
      return describeBooking(r);
    case "create_priority_dispatch":
      return {
        title: "Priority dispatch logged",
        detail: typeof r.callback_sla_minutes === "number" ? `On-call callback within ${r.callback_sla_minutes} min` : null,
        tone: "emergency",
        icon: "siren",
      };
    case "create_callback_request":
      return describeCallback(inv.args as Obj | null, r);
    case "check_service_area":
      return {
        title: r.coverage === "coverage_check" ? "Checked area: office coverage check" : r.in_area === true ? "Checked area: in service area" : "Checked area: outside",
        detail: str((inv.args as Obj | null)?.zip) ? `ZIP ${str((inv.args as Obj).zip)}` : null,
        tone: r.coverage === "coverage_check" ? "coverage" : "neutral",
        icon: "map",
      };
    case "transfer_to_on_call":
      return { title: "Transferred to the on-call team", detail: null, tone: "emergency", icon: "transfer" };
    default:
      return { title: inv.toolName.replace(/_/g, " "), detail: null, tone: "neutral", icon: "tool" };
  }
}

export function buildSteps(invocations: InvocationRow[]): CallStep[] {
  return invocations.map((inv) => ({
    id: inv.id,
    at: inv.createdAt,
    tool: inv.toolName,
    ok: inv.ok,
    ...describeInvocation(inv),
    chips: stepChips(inv.args as Obj | null),
    latencyMs: inv.latencyMs,
    dbMs: inv.dbMs,
  }));
}

export type ConversationItem = { kind: "message"; message: TranscriptMessage } | { kind: "step"; step: CallStep };

/** Transcript lines and tool steps in time order; a step sits after the line that triggered it. */
export function interleave(messages: TranscriptMessage[], steps: CallStep[]): ConversationItem[] {
  const items: ConversationItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, message: m })),
    ...steps.map((s) => ({ kind: "step" as const, step: s })),
  ];
  const at = (i: ConversationItem) => (i.kind === "message" ? i.message.at : i.step.at).getTime();
  // Stable: equal times keep messages before steps (the line, then what it triggered).
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => at(a.item) - at(b.item) || a.order - b.order)
    .map((x) => x.item);
}

/** Vapi's plain transcript ("AI: …" / "User: …"), when the timed messages aren't stored. */
export function parseTranscript(text: string): Array<{ role: "caller" | "ava" | null; text: string }> {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const m = /^(AI|User|Assistant|Bot|Customer)\s*:\s*(.*)$/i.exec(line);
      if (!m) return { role: null, text: line.trim() };
      return { role: /^(ai|assistant|bot)$/i.test(m[1]) ? ("ava" as const) : ("caller" as const), text: m[2] };
    });
}
