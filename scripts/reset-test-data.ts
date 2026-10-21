// CLI entry for `npm run db:reset-test` (compiled with tsconfig.scripts.json).
// Deletes all data created by calls and keeps seed rows. Without --confirm it only
// prints what it would delete.
import { createDb } from "../src/server/db/client";
import { countNonSeedData, resetNonSeedData } from "../src/server/db/reset-test-data";

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file; use injected env.
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("db:reset-test: DATABASE_URL is not set");
  const confirmed = process.argv.includes("--confirm");
  const target = new URL(url);

  const { db, pool } = createDb(url);
  try {
    if (!confirmed) {
      const wouldDelete = await countNonSeedData(db);
      console.log(JSON.stringify({ event: "db_reset_test", dryRun: true, host: target.host, database: target.pathname.slice(1), wouldDelete }));
      console.error("Nothing deleted. Re-run with --confirm to delete these rows: npm run db:reset-test -- --confirm");
      process.exitCode = 2;
      return;
    }
    const deleted = await resetNonSeedData(db);
    console.log(JSON.stringify({ event: "db_reset_test", ok: true, host: target.host, database: target.pathname.slice(1), deleted }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "db_reset_test", ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
