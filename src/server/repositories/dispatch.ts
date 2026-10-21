import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { dispatchRequests } from "@/server/db/schema";
import type { DispatchRepository } from "./types";

type Obj = Record<string, unknown>;
const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** New non-blank values win; lists combine without duplicates; nested objects merge the same way. */
export function mergeDetails(prev: Obj | null, next: Obj | null): Obj | null {
  if (!next) return prev;
  const out: Obj = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) {
    if (blank(v)) continue;
    const before = out[k];
    if (Array.isArray(v) && Array.isArray(before)) out[k] = [...new Map([...before, ...v].map((x) => [JSON.stringify(x), x])).values()];
    else if (v && typeof v === "object" && !Array.isArray(v) && before && typeof before === "object" && !Array.isArray(before)) out[k] = mergeDetails(before as Obj, v as Obj);
    else out[k] = v;
  }
  return out;
}

export function createDispatchRepository(db: Db): DispatchRepository {
  return {
    async ensureForCall(input, mode) {
      if (!input.vapiCallId) {
        const [row] = await db.insert(dispatchRequests).values({ ...input, status: "open" }).returning({ id: dispatchRequests.id });
        return { id: row.id, created: true };
      }
      const callId = input.vapiCallId;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispatch:${callId}`}))`);
        const [existing] = await tx
          .select()
          .from(dispatchRequests)
          .where(and(eq(dispatchRequests.vapiCallId, callId), inArray(dispatchRequests.urgency, ["safety_stop", "emergency"])))
          .orderBy(desc(dispatchRequests.createdAt))
          .limit(1);
        if (!existing) {
          const [row] = await tx.insert(dispatchRequests).values({ ...input, status: "open" }).returning({ id: dispatchRequests.id });
          return { id: row.id, created: true };
        }
        if (mode === "merge" && existing.status !== "resolved") {
          await tx
            .update(dispatchRequests)
            .set({
              urgency: existing.urgency === "safety_stop" || input.urgency === "safety_stop" ? "safety_stop" : existing.urgency,
              customerId: input.customerId ?? existing.customerId,
              callerPhone: input.callerPhone ?? existing.callerPhone,
              callerName: input.callerName || existing.callerName,
              address: mergeDetails(existing.address as Obj | null, input.address),
              reasons: [...new Set([...(existing.reasons ?? []), ...input.reasons])],
              intake: mergeDetails(existing.intake as Obj | null, input.intake) ?? {},
            })
            .where(eq(dispatchRequests.id, existing.id));
        }
        return { id: existing.id, created: false };
      });
    },

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
