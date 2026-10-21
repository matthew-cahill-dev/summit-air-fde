import type { Db } from "@/server/db/client";
import { createCallbackRepository } from "./callbacks";
import { createCallRepository } from "./calls";
import { createCustomerRepository } from "./customers";
import { createDispatchRepository } from "./dispatch";
import { createSchedulingRepository } from "./scheduling";
import { createServiceAreaRepository } from "./service-area";
import { createToolInvocationRepository } from "./tool-invocations";
import type { Repositories } from "./types";

export function createRepositories(db: Db): Repositories {
  return {
    customers: createCustomerRepository(db),
    serviceArea: createServiceAreaRepository(db),
    toolInvocations: createToolInvocationRepository(db),
    calls: createCallRepository(db),
    scheduling: createSchedulingRepository(db),
    dispatch: createDispatchRepository(db),
    callbacks: createCallbackRepository(db),
  };
}

export type * from "./types";
