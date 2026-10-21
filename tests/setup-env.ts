import { AsyncLocalStorage } from "node:async_hooks";
import { resetEnvCacheForTests } from "@/lib/env";

// Next's server runtime provides this global before loading any app code. Without it,
// importing next/server patches console/Date with stubs that throw (e.g. console.log in logEvent).
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;
import { testDatabaseUrl } from "./test-db-url";

// Fixed, obviously fake values. Never real secrets.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-0123456789";
process.env.DASHBOARD_PASSWORD = "test-dashboard-pw";
process.env.APP_URL = "http://localhost:3000";
process.env.APP_TIMEZONE = "America/New_York";
resetEnvCacheForTests();
