// Renders vapi/*.json and vapi/system-prompt.md into the exact config sent to Vapi.
// Keep this file free of path aliases: it is compiled for scripts/sync-vapi.ts.
import { BUSINESS } from "../config/business";

export type SyncEnv = {
  APP_URL: string;
  VAPI_CREDENTIAL_ID: string;
  APP_TIMEZONE: string;
  ON_CALL_TRANSFER_NUMBER?: string;
};

export type JsonObject = { [key: string]: unknown };

/** Business facts as prompt lines. Every value comes from src/config/business.ts (ASSUMPTIONS). */
export function businessFactsText(): string {
  const f = BUSINESS.facts;
  return [
    `- Service area: homes in ${f.serviceArea}.`,
    `- Services: ${f.servicesOffered}`,
    `- Not offered: ${f.notOffered}`,
    BUSINESS.commercialReferrals
      ? "- Commercial callers: the office can call back with referrals to commercial HVAC companies."
      : "- Commercial callers: we don't refer them to other companies. They'll want a commercial HVAC company.",
    // The office number is fictional (555-01xx), so it's deliberately not given to callers.
    `- Office hours: ${f.officeHours}.`,
    `- Appointments: ${f.appointmentHours}.`,
    `- On-call: ${f.onCallCoverage}`,
    `- Priority requests: Summit Air's policy is an on-call callback within ${BUSINESS.priorityDispatchCallbackSlaMinutes} minutes.`,
    `- Diagnostic fee: ${f.diagnosticFee}.`,
    ...f.membershipPlans.map((p) => `- Membership: ${p}`),
    `- Payment: ${f.payment}`,
  ].join("\n");
}

/** Mustache-style sections: <<#TRANSFER>>kept if on<</TRANSFER>>, <<^TRANSFER>>kept if off<</TRANSFER>>. */
function renderSections(text: string, flags: Record<string, boolean>): string {
  return text.replace(/<<([#^])([A-Z_]+)>>([\s\S]*?)<<\/\2>>/g, (_m, kind: string, name: string, body: string) => {
    if (!(name in flags)) throw new Error(`Unknown prompt section <<${kind}${name}>>`);
    return (kind === "#") === flags[name] ? body : "";
  });
}

export function renderSystemPrompt(template: string, opts: { transferAvailable: boolean; timeZone: string }): string {
  const values: Record<string, string> = {
    SERVICE_AREA: BUSINESS.facts.serviceArea,
    TIMEZONE: opts.timeZone,
    SLA_MINUTES: String(BUSINESS.priorityDispatchCallbackSlaMinutes),
    BUSINESS_FACTS: businessFactsText(),
  };
  let out = template.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  out = renderSections(out, { TRANSFER: opts.transferAvailable });
  out = out.replace(/<<([A-Z_]+)>>/g, (m, name: string) => {
    if (!(name in values)) throw new Error(`Unknown prompt placeholder ${m}`);
    return values[name];
  });
  const leftover = /<<[^>]*>>/.exec(out);
  if (leftover) throw new Error(`Unrendered prompt placeholder ${leftover[0]}`);
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Drop documentation keys (any key starting with "_"), recursively. */
export function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripComments) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, stripComments(v)]),
    ) as T;
  }
  return value;
}

/** Replace ${VAR} in every string. Unknown or empty variables are an error, never sent to Vapi. */
export function substituteVars<T>(value: T, vars: Record<string, string | undefined>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_]+)\}/g, (m, name: string) => {
      const v = vars[name];
      if (v === undefined || v === "") throw new Error(`Missing value for ${m}`);
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteVars(v, vars)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([k, v]) => [k, substituteVars(v, vars)])) as T;
  }
  return value;
}

/** The name a tool is matched by: function.name, or the type for unnamed built-ins. */
export function toolName(tool: JsonObject): string {
  const fn = tool.function as JsonObject | undefined;
  return typeof fn?.name === "string" ? fn.name : String(tool.type);
}

export const TRANSFER_TOOL_NAME = "transfer_to_on_call";

/** Tools to sync. The transfer tool is only included when ON_CALL_TRANSFER_NUMBER is set. */
export function buildDesiredTools(files: JsonObject[], env: SyncEnv): JsonObject[] {
  const transferAvailable = Boolean(env.ON_CALL_TRANSFER_NUMBER);
  return files
    .map(stripComments)
    .filter((t) => transferAvailable || toolName(t) !== TRANSFER_TOOL_NAME)
    .map((t) =>
      substituteVars(t, {
        APP_URL: env.APP_URL.replace(/\/+$/, ""),
        VAPI_CREDENTIAL_ID: env.VAPI_CREDENTIAL_ID,
        ON_CALL_TRANSFER_NUMBER: env.ON_CALL_TRANSFER_NUMBER,
      }),
    );
}

export function buildDesiredAssistant(
  assistantFile: JsonObject,
  systemPrompt: string,
  toolIds: string[],
  env: SyncEnv,
): JsonObject {
  const withVars = substituteVars(stripComments(assistantFile), {
    APP_URL: env.APP_URL.replace(/\/+$/, ""),
    VAPI_CREDENTIAL_ID: env.VAPI_CREDENTIAL_ID,
    SYSTEM_PROMPT: "\u0000SYSTEM_PROMPT\u0000", // placed below, so the prompt's own text is never re-scanned
    TOOL_IDS: "\u0000TOOL_IDS\u0000",
  });
  const model = { ...(withVars.model as JsonObject) };
  model.messages = (model.messages as JsonObject[]).map((m) =>
    m.content === "\u0000SYSTEM_PROMPT\u0000" ? { ...m, content: systemPrompt } : m,
  );
  if (model.toolIds !== "\u0000TOOL_IDS\u0000") throw new Error('assistant.json model.toolIds must be "${TOOL_IDS}"');
  model.toolIds = [...toolIds].sort();
  return { ...withVars, model };
}
