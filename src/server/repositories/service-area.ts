import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { serviceAreaZips } from "@/server/db/schema";
import type { ServiceAreaRepository } from "./types";

export function createServiceAreaRepository(db: Db): ServiceAreaRepository {
  return {
    async findZip(zip) {
      const [row] = await db.select().from(serviceAreaZips).where(eq(serviceAreaZips.zip, zip)).limit(1);
      return row ?? null;
    },
  };
}
