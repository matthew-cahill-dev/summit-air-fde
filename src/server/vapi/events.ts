import type { EndOfCallReport } from "@/server/repositories";
import { getMessage } from "./envelope";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Extract an end-of-call-report. Field locations vary between Vapi versions
 * (top-level message vs message.call), so each field checks both.
 * Returns null for any other message type or when there's no call id.
 */
export function parseEndOfCallReport(body: unknown): EndOfCallReport | null {
  const m = getMessage(body);
  if (!m || m.type !== "end-of-call-report") return null;
  const call = isObj(m.call) ? m.call : {};
  const vapiCallId = str(call.id);
  if (!vapiCallId) return null;

  const customer = isObj(call.customer) ? call.customer : isObj(m.customer) ? m.customer : {};
  const analysis = isObj(m.analysis) ? m.analysis : isObj(call.analysis) ? call.analysis : {};
  const artifact = isObj(m.artifact) ? m.artifact : isObj(call.artifact) ? call.artifact : {};

  return {
    vapiCallId,
    callerPhone: str(customer.number),
    startedAt: date(m.startedAt ?? call.startedAt),
    endedAt: date(m.endedAt ?? call.endedAt),
    endedReason: str(m.endedReason) ?? str(call.endedReason),
    summary: str(analysis.summary) ?? str(m.summary),
    transcript: str(artifact.transcript) ?? str(m.transcript),
    rawReport: m,
  };
}
