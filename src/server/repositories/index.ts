import type { Db } from "@/server/db/client";
import { createCallRepository } from "./calls";
import { createCustomerRepository } from "./customers";
import { createServiceAreaRepository } from "./service-area";
import { createToolInvocationRepository } from "./tool-invocations";
import type { Repositories } from "./types";

export function createRepositories(db: Db): Repositories {
  return {
    customers: createCustomerRepository(db),
    serviceArea: createServiceAreaRepository(db),
    toolInvocations: createToolInvocationRepository(db),
    calls: createCallRepository(db),
  };
}

export type * from "./types";
