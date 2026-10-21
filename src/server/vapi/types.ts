import type { z } from "zod";
import type { Repositories } from "@/server/repositories";

export type ToolSettings = {
  /** IANA zone for "today", seasons and spoken times. */
  timeZone: string;
  /** True when ON_CALL_TRANSFER_NUMBER is configured (transfer tool attached). */
  transferAvailable: boolean;
  /** DEMO_CALLER_PHONES: E.164 → seeded customer id. */
  demoCallerMap: ReadonlyMap<string, string>;
};

export type ToolContext = {
  /** Vapi call ID (body.message.call.id); null when Vapi didn't send one (e.g. dashboard tool test). */
  callId: string | null;
  /** Caller's number as Vapi sent it (body.message.call.customer.number), not normalized. */
  callerPhone: string | null;
  repos: Repositories;
  settings: ToolSettings;
  /** Request time; injected so tests can pin the clock. */
  now: Date;
  /** What the caller has said so far on this call (Vapi's live artifact), when the message carries it. */
  callerText?: string | null;
  /** Set when `prepare` repaired the arguments of an emergency or safety call instead of refusing them. */
  failOpen?: FailOpen | null;
};

/** Emergency and safety paths fail open: what was defaulted or dropped instead of refused. */
export type FailOpen = { notAsked: string[]; dropped: string[] };

/**
 * What a tool handler returns. Serialized into the Vapi `result` (ok) or `error` (not ok) string.
 * `say` is required: every result tells the model its next step, so the call order lives in the
 * tool results, not in a checklist the model sees from the first turn.
 */
export type ToolOutcome =
  | { ok: true; data: Record<string, unknown>; say: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      say: string;
      data?: Record<string, unknown>;
    };

export type ToolDefinition<S extends z.ZodType = z.ZodType> = {
  schema: S;
  /**
   * Runs before schema validation. Emergency and safety calls use it to fail open: missing or
   * invalid fields are defaulted or dropped (and reported in `failOpen`) instead of refused.
   */
  prepare?: (rawArgs: Record<string, unknown>, ctx: ToolContext) => Promise<{ args: Record<string, unknown>; failOpen: FailOpen | null }>;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>;
};

/** Identity helper that ties a handler's arg type to its schema. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}
