import type { Db } from "@/server/db/client";
import { callbackRequests } from "@/server/db/schema";
import type { CallbackRepository } from "./types";

export function createCallbackRepository(db: Db): CallbackRepository {
  return {
    async create(input) {
      const [row] = await db
        .insert(callbackRequests)
        .values({ ...input, status: "open" })
        .returning({ id: callbackRequests.id });
      return row;
    },
  };
}
