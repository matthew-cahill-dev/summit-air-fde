import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { callbackRequests } from "@/server/db/schema";
import type { CallbackRepository } from "./types";

export function createCallbackRepository(db: Db): CallbackRepository {
  return {
    async create(input) {
      const [row] = await db
        .insert(callbackRequests)
        .values({ ...input, status: "open" })
        .returning({ id: callbackRequests.id });
      return row;
    },

    async markDone(id, at) {
      const [row] = await db
        .update(callbackRequests)
        .set({ status: "done", completedAt: at })
        .where(and(eq(callbackRequests.id, id), eq(callbackRequests.status, "open")))
        .returning({ id: callbackRequests.id, status: callbackRequests.status });
      return row ?? null;
    },
  };
}
