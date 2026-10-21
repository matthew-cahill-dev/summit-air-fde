// Console actions behind the Server Actions: the dispatch lifecycle (New → Called back →
// Resolved with an outcome) and the appointment lifecycle (Completed / No-show / Cancelled /
// Rescheduled). Framework-free so tests can call them with the test database;
// src/app/(console)/actions.ts adds auth + refresh. Every successful action returns an undo token
// the console offers for 5 seconds.
import { z } from "zod";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";
import {
  cancelAppointment,
  closeAppointment,
  reopenAppointment,
  rescheduleAppointment,
  uncancelAppointment,
  undoReschedule,
} from "@/server/services/appointment-lifecycle";
import { RESOLUTIONS } from "./board";

export type UndoToken =
  | { op: "uncall"; kind: "dispatch" | "callback"; id: string }
  | { op: "unresolve"; kind: "dispatch" | "callback"; id: string }
  | { op: "reopen_appointment" | "uncancel_appointment" | "undo_reschedule"; id: string };

export type ConsoleActionResult = { ok: true; message: string; undo?: UndoToken; appointmentId?: string } | { ok: false; error: string };
/** @deprecated name kept for older imports. */
export type BoardActionResult = ConsoleActionResult;

const id = z.uuid();
const kind = z.enum(["dispatch", "callback"]);
const by = z.string().trim().max(60).optional().transform((v) => (v ? v : null));
const note = z.string().trim().max(500).optional().transform((v) => (v ? v : null));
const resolution = z.enum(RESOLUTIONS);

type Deps = { repos: Pick<Repositories, "dispatch" | "callbacks" | "scheduling" | "customers">; now?: Date; timeZone?: string };

async function guarded(action: string, fn: () => Promise<ConsoleActionResult>): Promise<ConsoleActionResult> {
  try {
    const result = await fn();
    logEvent("console_action", { action, ok: result.ok });
    return result;
  } catch (err) {
    logEvent("console_action_failed", { action, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Couldn't save that. Try again." };
  }
}

const bad = (error = "Unknown request."): ConsoleActionResult => ({ ok: false, error });

/** "Called back": the customer has been reached, which stops the callback SLA. */
export function markCalledBack(input: { kind: unknown; id: unknown; by?: unknown }, deps: Deps): Promise<ConsoleActionResult> {
  const p = z.object({ kind, id, by }).safeParse(input);
  if (!p.success) return Promise.resolve(bad());
  const { kind: k, id: i, by: who } = p.data;
  return guarded(`${k}_called_back`, async () => {
    const now = deps.now ?? new Date();
    const row = k === "dispatch" ? await deps.repos.dispatch.acknowledge(i, now, who) : await deps.repos.callbacks.markCalledBack(i, now, who);
    return row ? { ok: true, message: "Marked called back", undo: { op: "uncall", kind: k, id: i } } : bad("Already called back or resolved.");
  });
}

/** Resolved, with an outcome and an optional note. */
export function resolveItem(
  input: { kind: unknown; id: unknown; resolution: unknown; note?: unknown; by?: unknown },
  deps: Deps,
): Promise<ConsoleActionResult> {
  const p = z.object({ kind, id, resolution, note, by }).safeParse(input);
  if (!p.success) return Promise.resolve(bad("Pick an outcome to resolve it."));
  const { kind: k, id: i, resolution: r, note: n, by: who } = p.data;
  return guarded(`${k}_resolve`, async () => {
    const now = deps.now ?? new Date();
    const detail = { resolution: r, note: n, by: who };
    const row = k === "dispatch" ? await deps.repos.dispatch.resolve(i, now, detail) : await deps.repos.callbacks.markDone(i, now, detail);
    return row ? { ok: true, message: `Resolved · ${r}`, undo: { op: "unresolve", kind: k, id: i } } : bad("Already resolved.");
  });
}

export function completeAppointment(input: { id: unknown; outcome: unknown; note?: unknown; by?: unknown }, deps: Deps): Promise<ConsoleActionResult> {
  const p = z.object({ id, outcome: z.enum(["completed", "no_show"]), note, by }).safeParse(input);
  if (!p.success) return Promise.resolve(bad());
  return guarded(`appointment_${p.data.outcome}`, async () => {
    const r = await closeAppointment(p.data.id, p.data.outcome, p.data.note, p.data.by, { ...deps, now: deps.now ?? new Date() });
    return r.ok ? { ok: true, message: r.message, undo: { op: "reopen_appointment", id: p.data.id } } : r;
  });
}

export function cancelAppointmentAction(input: { id: unknown; by?: unknown }, deps: Deps): Promise<ConsoleActionResult> {
  const p = z.object({ id, by }).safeParse(input);
  if (!p.success) return Promise.resolve(bad());
  return guarded("appointment_cancel", async () => {
    const r = await cancelAppointment(p.data.id, p.data.by, { ...deps, now: deps.now ?? new Date() });
    return r.ok ? { ok: true, message: r.message, undo: { op: "uncancel_appointment", id: p.data.id } } : r;
  });
}

export function rescheduleAppointmentAction(input: { id: unknown; slotId: unknown; by?: unknown }, deps: Deps): Promise<ConsoleActionResult> {
  const p = z.object({ id, slotId: z.uuid(), by }).safeParse(input);
  if (!p.success) return Promise.resolve(bad("Pick a new window."));
  return guarded("appointment_reschedule", async () => {
    const r = await rescheduleAppointment(p.data.id, p.data.slotId, p.data.by, { ...deps, now: deps.now ?? new Date() });
    return r.ok ? { ok: true, message: r.message, appointmentId: r.appointmentId, undo: { op: "undo_reschedule", id: r.appointmentId } } : r;
  });
}

const undoSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("uncall"), kind, id }),
  z.object({ op: z.literal("unresolve"), kind, id }),
  z.object({ op: z.enum(["reopen_appointment", "uncancel_appointment", "undo_reschedule"]), id }),
]);

/** Reverses an action from its undo token. */
export function undoAction(token: unknown, deps: Deps): Promise<ConsoleActionResult> {
  const p = undoSchema.safeParse(token);
  if (!p.success) return Promise.resolve(bad());
  const t = p.data;
  return guarded(`undo_${t.op}`, async () => {
    const now = deps.now ?? new Date();
    if (t.op === "uncall") {
      const row = t.kind === "dispatch" ? await deps.repos.dispatch.unacknowledge(t.id) : await deps.repos.callbacks.unmarkCalledBack(t.id);
      return row ? { ok: true, message: "Undone" } : bad("Nothing to undo.");
    }
    if (t.op === "unresolve") {
      const row = t.kind === "dispatch" ? await deps.repos.dispatch.unresolve(t.id) : await deps.repos.callbacks.reopen(t.id);
      return row ? { ok: true, message: "Undone" } : bad("Nothing to undo.");
    }
    const lifecycle = { ...deps, now };
    const r =
      t.op === "reopen_appointment"
        ? await reopenAppointment(t.id, lifecycle)
        : t.op === "uncancel_appointment"
          ? await uncancelAppointment(t.id, lifecycle)
          : await undoReschedule(t.id, lifecycle);
    return r.ok ? { ok: true, message: "Undone" } : r;
  });
}
