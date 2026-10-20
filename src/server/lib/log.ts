// One JSON object per line on stdout. Callers must never pass secrets,
// auth headers or full tool arguments.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
