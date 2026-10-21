// Requirement (c), enforced: every residential call checks membership first. Live call 01a15f31
// skipped lookup_customer entirely and booked a member as a new customer, so triage_issue and
// unverified book_appointment refuse until lookup_customer has run on this call. Commercial callers
// skip lookup by design, and safety never waits on it.
import { logEvent } from "@/server/lib/log";
import type { ToolContext, ToolOutcome } from "@/server/vapi/types";

export const LOOKUP_REQUIRED_SAY = "First call lookup_customer with no arguments (caller ID), then follow its next step.";

/** Null when lookup_customer already ran on this call (or there's no call id, e.g. a dashboard test). */
export async function requireLookup(ctx: ToolContext, tool: string): Promise<ToolOutcome | null> {
  if (!ctx.callId) return null;
  if (await ctx.repos.toolInvocations.wasInvoked(ctx.callId, "lookup_customer")) return null;
  logEvent("lookup_required", { callId: ctx.callId, tool });
  return {
    ok: false,
    errorCode: "lookup_required",
    message: "lookup_customer hasn't run on this call",
    say: LOOKUP_REQUIRED_SAY,
    data: { invalid_fields: [{ field: "lookup_customer", problem: "call it first" }] },
  };
}
