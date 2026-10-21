import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import type { HealthRepository } from "./types";

export function createHealthRepository(db: Db): HealthRepository {
  return {
    async ping() {
      await db.execute(sql`select 1`);
    },
  };
}
