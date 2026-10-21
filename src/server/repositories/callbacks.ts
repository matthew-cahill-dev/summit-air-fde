import { and, asc, eq, sql } from "drizzle-orm";
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

    async upsertOpenForCall(input, merge) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"callback:" + input.vapiCallId}))`);
        const [existing] = await tx
          .select({
            id: callbackRequests.id,
            reason: callbackRequests.reason,
            callerName: callbackRequests.callerName,
            callerPhone: callbackRequests.callerPhone,
            context: callbackRequests.context,
          })
          .from(callbackRequests)
          .where(and(eq(callbackRequests.vapiCallId, input.vapiCallId), eq(callbackRequests.status, "open")))
          .orderBy(asc(callbackRequests.createdAt))
          .limit(1);
        if (!existing) {
          const [row] = await tx.insert(callbackRequests).values({ ...input, status: "open" }).returning({ id: callbackRequests.id });
          return { id: row.id, updated: false };
        }
        const next = merge({ ...existing, context: (existing.context ?? {}) as Record<string, unknown> });
        await tx.update(callbackRequests).set(next).where(eq(callbackRequests.id, existing.id));
        return { id: existing.id, updated: true };
      });
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
