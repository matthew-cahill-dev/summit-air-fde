import { productionVapiDeps } from "@/server/http/deps";
import { handleToolsRequest } from "@/server/vapi/http";

// Vapi custom function tools. See src/server/vapi/http.ts.
export async function POST(request: Request) {
  return handleToolsRequest(request, productionVapiDeps());
}
