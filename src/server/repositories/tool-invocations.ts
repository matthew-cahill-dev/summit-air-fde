import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { toolInvocations } from "@/server/db/schema";
import { RETRYABLE_ERROR_CODES, type StoredInvocation, type ToolInvocationRepository } from "./types";

const columns = {
  idempotencyKey: toolInvocations.idempotencyKey,
  toolName: toolInvocations.toolName,
  ok: toolInvocations.ok,
  result: toolInvocations.result,
};

function toStored(row: { idempotencyKey: string; toolName: string; ok: boolean; result: unknown }): StoredInvocation {
  return { ...row, result: (row.result ?? {}) as Record<string, unknown> };
}

export function createToolInvocationRepository(db: Db): ToolInvocationRepository {
  async function findByKey(key: string): Promise<StoredInvocation | null> {
    const [row] = await db.select(columns).from(toolInvocations).where(eq(toolInvocations.idempotencyKey, key)).limit(1);
    return row ? toStored(row) : null;
  }

  return {
    findByKey,

    async countFailedVerifications(vapiCallId) {
      const [row] = await db
        .select({ n: count() })
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.vapiCallId, vapiCallId),
            eq(toolInvocations.toolName, "lookup_customer"),
            sql`${toolInvocations.result}->>'verification_failed' = 'true'`,
          ),
        );
      return row?.n ?? 0;
    },

    async wasInvoked(vapiCallId, toolName) {
      const [row] = await db
        .select({ id: toolInvocations.id })
        .from(toolInvocations)
        .where(and(eq(toolInvocations.vapiCallId, vapiCallId), eq(toolInvocations.toolName, toolName)))
        .limit(1);
      return Boolean(row);
    },

    async okResults(vapiCallId, toolName) {
      const rows = await db
        .select({ result: toolInvocations.result })
        .from(toolInvocations)
        .where(and(eq(toolInvocations.vapiCallId, vapiCallId), eq(toolInvocations.toolName, toolName), eq(toolInvocations.ok, true)))
        .orderBy(toolInvocations.createdAt);
      return rows.map((r) => (r.result ?? {}) as Record<string, unknown>);
    },

    async latestOkArgs(vapiCallId, toolName) {
      const [row] = await db
        .select({ args: toolInvocations.args })
        .from(toolInvocations)
        .where(and(eq(toolInvocations.vapiCallId, vapiCallId), eq(toolInvocations.toolName, toolName), eq(toolInvocations.ok, true)))
        .orderBy(desc(toolInvocations.createdAt))
        .limit(1);
      const args = row?.args;
      return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
    },

    async record(input) {
      const values = {
        idempotencyKey: input.idempotencyKey,
        vapiCallId: input.vapiCallId,
        toolName: input.toolName,
        args: input.args ?? null,
        ok: input.ok,
        result: input.result,
        latencyMs: input.latencyMs,
        dbMs: input.dbMs ?? null,
      };
      const [written] = await db
        .insert(toolInvocations)
        .values(values)
        .onConflictDoUpdate({
          target: toolInvocations.idempotencyKey,
          set: {
            ok: sql`excluded.ok`,
            result: sql`excluded.result`,
            latencyMs: sql`excluded.latency_ms`,
            dbMs: sql`excluded.db_ms`,
            createdAt: sql`now()`,
          },
          // Only a retryable failure (transient, or "call lookup_customer first") may be replaced by a retry.
          setWhere: and(eq(toolInvocations.ok, false), inArray(sql`${toolInvocations.result}->>'error_code'`, [...RETRYABLE_ERROR_CODES])),
        })
        .returning(columns);
      if (written) return toStored(written);

      // Conflict with a non-retryable stored row: that row wins.
      const existing = await findByKey(input.idempotencyKey);
      if (!existing) throw new Error("tool_invocations: conflict but no stored row");
      return existing;
    },
  };
}
