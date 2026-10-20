import type { z } from "zod";
import type { Repositories } from "@/server/repositories";

export type ToolContext = {
  /** Vapi call ID (body.message.call.id); null when Vapi didn't send one (e.g. dashboard tool test). */
  callId: string | null;
  /** Caller's number as Vapi sent it (body.message.call.customer.number), not normalized. */
  callerPhone: string | null;
  repos: Repositories;
};

/** What a tool handler returns. Serialized into the Vapi `result` (ok) or `error` (not ok) string. */
export type ToolOutcome =
  | { ok: true; data: Record<string, unknown>; say?: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      say?: string;
      data?: Record<string, unknown>;
    };

export type ToolDefinition<S extends z.ZodType = z.ZodType> = {
  schema: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>;
};

/** Identity helper that ties a handler's arg type to its schema. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}
