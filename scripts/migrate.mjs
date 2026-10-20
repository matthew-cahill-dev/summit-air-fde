// Applies drizzle/ migrations. Plain JS on purpose: it runs at deploy time with
// runtime dependencies only (drizzle-orm + pg), no TypeScript toolchain needed.
// An advisory lock keeps concurrent instances from migrating at the same time.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file (e.g. on Replit). Use injected env.
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set");
  process.exit(1);
}

const MIGRATION_LOCK_ID = 727_001; // arbitrary, app-specific
const client = new pg.Client({ connectionString: url });
const started = Date.now();

try {
  await client.connect();
  await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log(JSON.stringify({ event: "db_migrate", ok: true, ms: Date.now() - started }));
} catch (err) {
  console.error(
    JSON.stringify({ event: "db_migrate", ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  process.exitCode = 1;
} finally {
  await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
  await client.end();
}
