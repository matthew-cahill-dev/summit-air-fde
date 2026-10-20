import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getEnv } from "@/lib/env";
import { getDbFor } from "@/server/db/client";

export async function GET() {
  await connection(); // always run at request time, never prerender
  const started = performance.now();
  try {
    const db = getDbFor(getEnv().DATABASE_URL);
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", db: "ok", db_ms: Math.round(performance.now() - started) });
  } catch (err) {
    // Don't echo the error: it can contain connection details.
    console.error(JSON.stringify({ event: "health_db_failed", error: err instanceof Error ? err.name : "unknown" }));
    return Response.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
