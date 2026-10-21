// Prepares a real Postgres test database: create if missing, migrate, seed,
// and clear per-run tables. See README "Testing" for why we use a real DB.
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { createDb } from "../src/server/db/client";
import { seed } from "../src/server/db/seed";
import { testDatabaseUrl } from "./test-db-url";

async function ensureDatabase(url: string) {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [dbName]);
    if (!rowCount) await client.query(`create database "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

export default async function setup() {
  const url = testDatabaseUrl();
  try {
    await ensureDatabase(url);
  } catch (err) {
    throw new Error(
      `Test database unavailable at ${new URL(url).host}. Start Postgres (brew services start postgresql@17) ` +
        `or set TEST_DATABASE_URL. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    // Reset everything tests write; the seed then restores demo rows and fresh slots.
    await db.execute(sql`truncate tool_invocations, calls, appointments, dispatch_requests, callback_requests`);
    await db.execute(sql`delete from appointment_slots`);
    await db.execute(sql`delete from customers where is_demo_seed = false`);
    await seed(db, { timeZone: "America/New_York" });
  } finally {
    await pool.end();
  }
}
