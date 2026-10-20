import { checkServiceAreaTool } from "@/server/services/check-service-area";
import { lookupCustomerTool } from "@/server/services/lookup-customer";
import type { ToolDefinition } from "./types";

export type ToolRegistry = Record<string, ToolDefinition>;

// Tool name (as configured in Vapi) → schema + handler.
export const TOOL_REGISTRY: ToolRegistry = {
  lookup_customer: lookupCustomerTool as ToolDefinition,
  check_service_area: checkServiceAreaTool as ToolDefinition,
};
