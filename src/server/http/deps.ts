import { getEnv } from "@/lib/env";
import { getDbFor } from "@/server/db/client";
import { createRepositories } from "@/server/repositories";
import { TOOL_REGISTRY } from "@/server/vapi/registry";
import type { VapiHttpDeps } from "@/server/vapi/http";

/** Production wiring: env-backed secret, process-wide DB pool. */
export function productionVapiDeps(): VapiHttpDeps {
  const env = getEnv();
  return {
    secret: env.VAPI_TOOL_SECRET,
    repos: () => createRepositories(getDbFor(env.DATABASE_URL)),
    registry: TOOL_REGISTRY,
    settings: {
      timeZone: env.APP_TIMEZONE,
      transferAvailable: Boolean(env.ON_CALL_TRANSFER_NUMBER),
      demoCallerMap: env.DEMO_CALLER_PHONES,
    },
  };
}
