import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    // Fail fast: a voice caller is waiting on every query.
    connectionTimeoutMillis: 3_000,
    statement_timeout: 2_000,
    // Keep connections open between tool calls. Measured on production (Oct 21): a query after
    // more than 30 s idle took 240-251 ms instead of 27 ms, because the old 30 s idle timeout had
    // closed the connection and it had to reconnect (TLS + auth). Tool calls in one phone call are
    // often 30+ s apart, so each paid that. 10 minutes covers a whole call.
    idleTimeoutMillis: 600_000,
    keepAlive: true,
  });
  // An idle connection the server drops emits "error" on the pool; without a listener that would
  // crash the process. The pool discards the client and opens a new one on the next query.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ event: "db_pool_idle_error", error: err.message }));
  });
  return { db: drizzle(pool, { schema }), pool };
}

// One pool per process; survive Next.js dev hot reloads.
const globalForDb = globalThis as unknown as { __summitDb?: { db: Db; pool: Pool; url: string } };

export function getDbFor(databaseUrl: string): Db {
  const existing = globalForDb.__summitDb;
  if (existing && existing.url === databaseUrl) return existing.db;
  const created = createDb(databaseUrl);
  globalForDb.__summitDb = { ...created, url: databaseUrl };
  return created.db;
}
