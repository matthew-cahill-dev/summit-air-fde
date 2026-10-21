import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { calls } from "@/server/db/schema";
import type { CallRepository } from "./types";

export function createCallRepository(db: Db): CallRepository {
  return {
    async upsertEndOfCallReport(r) {
      const values = {
        vapiCallId: r.vapiCallId,
        callerPhone: r.callerPhone,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        endedReason: r.endedReason,
        summary: r.summary,
        transcript: r.transcript,
        rawReport: r.rawReport,
        responseP50Ms: r.responseP50Ms ?? null,
        responseP95Ms: r.responseP95Ms ?? null,
        responseTurns: r.responseTurns ?? null,
        isSimulation: r.isSimulation ?? false,
      };
      await db
        .insert(calls)
        .values(values)
        .onConflictDoUpdate({
          target: calls.vapiCallId,
          set: {
            // Don't wipe values we already have with nulls from a sparser report.
            callerPhone: sql`coalesce(excluded.caller_phone, ${calls.callerPhone})`,
            startedAt: sql`coalesce(excluded.started_at, ${calls.startedAt})`,
            endedAt: sql`coalesce(excluded.ended_at, ${calls.endedAt})`,
            endedReason: sql`coalesce(excluded.ended_reason, ${calls.endedReason})`,
            summary: sql`coalesce(excluded.summary, ${calls.summary})`,
            transcript: sql`coalesce(excluded.transcript, ${calls.transcript})`,
            rawReport: sql`excluded.raw_report`,
            responseP50Ms: sql`coalesce(excluded.response_p50_ms, ${calls.responseP50Ms})`,
            responseP95Ms: sql`coalesce(excluded.response_p95_ms, ${calls.responseP95Ms})`,
            responseTurns: sql`coalesce(excluded.response_turns, ${calls.responseTurns})`,
            isSimulation: sql`excluded.is_simulation or ${calls.isSimulation}`,
          },
        });
    },
  };
}
