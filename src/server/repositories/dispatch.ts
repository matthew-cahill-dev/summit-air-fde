import { and, desc, eq } from "drizzle-orm";
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
  };
}
