// CLI entry for `npm run db:seed` (compiled with tsconfig.scripts.json).
import { createDb } from "../src/server/db/client";
import { seed } from "../src/server/db/seed";

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file; use injected env.
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("db:seed: DATABASE_URL is not set");
  const timeZone = process.env.APP_TIMEZONE || "America/New_York";

  const { db, pool } = createDb(url);
  try {
    const summary = await seed(db, { timeZone });
    console.log(JSON.stringify({ event: "db_seed", ok: true, ...summary }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "db_seed", ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
