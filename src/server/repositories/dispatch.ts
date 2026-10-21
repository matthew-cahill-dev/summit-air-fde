import { and, desc, eq, inArray } from "drizzle-orm";
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

    async acknowledge(id, at) {
      // Conditional update: a concurrent Resolve or a second click is a no-op, not a regression.
      const [row] = await db
        .update(dispatchRequests)
        .set({ status: "acknowledged", acknowledgedAt: at })
        .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "open")))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },

    async resolve(id, at) {
      const [row] = await db
        .update(dispatchRequests)
        .set({ status: "resolved", resolvedAt: at })
        .where(and(eq(dispatchRequests.id, id), inArray(dispatchRequests.status, ["open", "acknowledged"])))
        .returning({ id: dispatchRequests.id, status: dispatchRequests.status });
      return row ?? null;
    },
  };
}
