import { productionVapiDeps } from "@/server/http/deps";
import { handleEventsRequest } from "@/server/vapi/http";

// Vapi server messages (end-of-call-report). See src/server/vapi/http.ts.
export async function POST(request: Request) {
  return handleEventsRequest(request, productionVapiDeps());
}
