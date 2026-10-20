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
    idleTimeoutMillis: 30_000,
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
