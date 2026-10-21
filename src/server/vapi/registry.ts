import { bookAppointmentTool } from "@/server/services/book-appointment";
import { createCallbackRequestTool } from "@/server/services/callback-request";
import { checkServiceAreaTool } from "@/server/services/check-service-area";
import { getAvailabilityTool } from "@/server/services/get-availability";
import { lookupCustomerTool } from "@/server/services/lookup-customer";
import { createPriorityDispatchTool } from "@/server/services/priority-dispatch";
import { triageIssueTool } from "@/server/services/triage-issue";
import type { ToolDefinition } from "./types";

export type ToolRegistry = Record<string, ToolDefinition>;

// Tool name (as configured in Vapi) → schema + handler.
export const TOOL_REGISTRY: ToolRegistry = {
  lookup_customer: lookupCustomerTool as ToolDefinition,
  check_service_area: checkServiceAreaTool as ToolDefinition,
  triage_issue: triageIssueTool as ToolDefinition,
  get_availability: getAvailabilityTool as ToolDefinition,
  book_appointment: bookAppointmentTool as ToolDefinition,
  create_priority_dispatch: createPriorityDispatchTool as ToolDefinition,
  create_callback_request: createCallbackRequestTool as ToolDefinition,
};
