// Parsing for Vapi server messages. Shape per https://docs.vapi.ai/tools/custom-tools
// and https://docs.vapi.ai/server-url/events. Parsed defensively: we don't trust
// any field to be present, and log the top-level keys so the real shape can be confirmed.

export type ParsedToolCall = {
  toolCallId: string;
  name: string;
  /** Parsed arguments object, or null when they couldn't be parsed. */
  args: Record<string, unknown> | null;
  argsError?: string;
};

export type ParsedToolCalls = {
  callId: string | null;
  callerPhone: string | null;
  toolCalls: ParsedToolCall[];
  /** Entries we can't answer because they have no id. */
  droppedWithoutId: number;
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function getMessage(body: unknown): Obj | null {
  return isObj(body) && isObj(body.message) ? body.message : null;
}

/** arguments may arrive as an object or a JSON string. */
export function parseToolArguments(raw: unknown): { args: Record<string, unknown> | null; error?: string } {
  if (raw === undefined || raw === null) return { args: {} };
  if (isObj(raw)) return { args: raw };
  if (typeof raw === "string") {
    if (raw.trim() === "") return { args: {} };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObj(parsed)) return { args: parsed };
      return { args: null, error: "arguments must be a JSON object" };
    } catch {
      return { args: null, error: "arguments is not valid JSON" };
    }
  }
  return { args: null, error: "arguments must be an object or JSON string" };
}

export function parseToolCallsEnvelope(body: unknown): ParsedToolCalls | null {
  const message = getMessage(body);
  if (!message || message.type !== "tool-calls") return null;

  const call = isObj(message.call) ? message.call : null;
  const customer = call && isObj(call.customer) ? call.customer : isObj(message.customer) ? message.customer : null;

  // Prefer toolCallList; fall back to toolWithToolCallList[].toolCall.
  let entries: unknown[] = Array.isArray(message.toolCallList) ? message.toolCallList : [];
  if (entries.length === 0 && Array.isArray(message.toolWithToolCallList)) {
    entries = message.toolWithToolCallList.map((t) => (isObj(t) ? t.toolCall : undefined));
  }

  const toolCalls: ParsedToolCall[] = [];
  let droppedWithoutId = 0;
  for (const entry of entries) {
    if (!isObj(entry) || !str(entry.id)) {
      droppedWithoutId++;
      continue;
    }
    const fn = isObj(entry.function) ? entry.function : {};
    const { args, error } = parseToolArguments(fn.arguments);
    toolCalls.push({ toolCallId: entry.id as string, name: str(fn.name) ?? "", args, argsError: error });
  }

  return {
    callId: call ? str(call.id) : null,
    callerPhone: customer ? str(customer.number) : null,
    toolCalls,
    droppedWithoutId,
  };
}

/** Key names only (no values) so logs can confirm the real envelope shape without leaking data. */
export function describeEnvelopeShape(body: unknown) {
  const message = getMessage(body);
  const call = message && isObj(message.call) ? message.call : null;
  return {
    topLevelKeys: isObj(body) ? Object.keys(body) : [],
    messageType: message ? (str(message.type) ?? null) : null,
    messageKeys: message ? Object.keys(message) : [],
    callKeys: call ? Object.keys(call) : [],
    hasCallerNumber: Boolean(call && isObj(call.customer) && str(call.customer.number)),
  };
}
