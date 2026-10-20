import { resetEnvCacheForTests } from "@/lib/env";
import { testDatabaseUrl } from "./test-db-url";

// Fixed, obviously fake values. Never real secrets.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-0123456789";
process.env.DASHBOARD_PASSWORD = "test-dashboard-pw";
process.env.APP_URL = "http://localhost:3000";
process.env.APP_TIMEZONE = "America/New_York";
resetEnvCacheForTests();
