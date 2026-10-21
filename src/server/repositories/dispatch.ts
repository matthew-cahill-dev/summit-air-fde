import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { dispatchRequests } from "@/server/db/schema";
import type { DispatchRepository } from "./types";

export function createDispatchRepository(db: Db): DispatchRepository {
  return {
    async create(input) {
      const [row] = await db
        .insert(dispatchRequests)
        .values({ ...input, status: "open" })
        .returning({ id: dispatchRequests.id });
      return row;
    },

    async findSafetyOrEmergencyForCall(vapiCallId) {
      const [row] = await db
        .select({ id: dispatchRequests.id })
        .from(dispatchRequests)
        .where(and(eq(dispatchRequests.vapiCallId, vapiCallId), inArray(dispatchRequests.urgency, ["safety_stop", "emergency"])))
        .limit(1);
      return row ?? null;
    },

    async findOpenForCall(vapiCallId, urgency) {
      const [row] = await db
        .select({ id: dispatchRequests.id })
        .from(dispatchRequests)
        .where(
          and(
            eq(dispatchRequests.vapiCallId, vapiCallId),
            eq(dispatchRequests.urgency, urgency),
            eq(dispatchRequests.status, "open"),
          ),
        )
        .orderBy(desc(dispatchRequests.createdAt))
        .limit(1);
      return row ?? null;
    },

    async acknowledge(id, at, by) {
      // Conditional update: a concurrent Resolve or a second click is a no-op, not a regression.
      const [row] = await db
        .update(dispatchRequests)
        .set({ status: "acknowledged", acknowledgedAt: at, acknowledgedBy: by ?? null })
        .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "open")))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },

    async unacknowledge(id) {
      const [row] = await db
        .update(dispatchRequests)
        .set({ status: "open", acknowledgedAt: null, acknowledgedBy: null })
        .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "acknowledged")))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },

    async resolve(id, at, detail) {
      const [row] = await db
        .update(dispatchRequests)
        .set({
          status: "resolved",
          resolvedAt: at,
          resolution: detail?.resolution ?? null,
          resolutionNote: detail?.note ?? null,
          resolvedBy: detail?.by ?? null,
        })
        .where(and(eq(dispatchRequests.id, id), inArray(dispatchRequests.status, ["open", "acknowledged"])))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },

    async unresolve(id) {
      // Back to where it was: called back if it had been, otherwise new.
      const [row] = await db
        .update(dispatchRequests)
        .set({
          status: sql`case when ${dispatchRequests.acknowledgedAt} is not null then 'acknowledged'::dispatch_status else 'open'::dispatch_status end`,
          resolvedAt: null,
          resolution: null,
          resolutionNote: null,
          resolvedBy: null,
        })
        .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "resolved")))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },
  };
}
