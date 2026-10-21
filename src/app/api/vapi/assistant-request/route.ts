import { getEnv } from "@/lib/env";
import { getDbFor } from "@/server/db/client";
import { createCustomerRepository } from "@/server/repositories/customers";
import { handleAssistantRequest } from "@/server/vapi/assistant-request";

// Vapi assistant-request (stretch, off unless ASSISTANT_REQUEST_ENABLED=true).
// See src/server/vapi/assistant-request.ts.
export async function POST(request: Request) {
  const env = getEnv();
  return handleAssistantRequest(request, {
    secret: env.VAPI_TOOL_SECRET,
    enabled: env.ASSISTANT_REQUEST_ENABLED,
    assistantId: env.VAPI_ASSISTANT_ID,
    customers: () => createCustomerRepository(getDbFor(env.DATABASE_URL)),
    demoCallerMap: env.DEMO_CALLER_PHONES,
  });
}
