// Minimal Vapi REST client (https://api.vapi.ai). Never logs the API key.
// Keep this file free of path aliases: it is compiled for scripts/sync-vapi.ts.
import type { JsonObject } from "./render";

export interface VapiApi {
  listTools(): Promise<JsonObject[]>;
  createTool(body: JsonObject): Promise<JsonObject>;
  updateTool(id: string, body: JsonObject): Promise<JsonObject>;
  getAssistant(id: string): Promise<JsonObject>;
  updateAssistant(id: string, body: JsonObject): Promise<JsonObject>;
  /** Names a published version (Vapi assistant versioning). Best effort. */
  labelAssistantVersion(id: string, version: string, body: { versionName: string; versionDescription?: string }): Promise<void>;
}

export class VapiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`Vapi ${method} ${path} failed with HTTP ${status}: ${body.slice(0, 800)}`);
  }
}

export function createVapiHttpApi(apiKey: string, baseUrl = "https://api.vapi.ai", fetchImpl: typeof fetch = fetch): VapiApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new VapiHttpError(res.status, method, path, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async listTools() {
      // GET /tool returns a bare array (limit ≤ 1000, no cursor): page backwards by createdAt.
      const seen = new Map<string, JsonObject>();
      let createdAtLe: string | undefined;
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ limit: "1000", ...(createdAtLe ? { createdAtLe } : {}) });
        const batch = await request<JsonObject[]>("GET", `/tool?${qs}`);
        const before = seen.size;
        for (const t of batch) seen.set(String(t.id), t);
        if (batch.length < 1000 || seen.size === before) break;
        createdAtLe = batch.map((t) => String(t.createdAt)).sort()[0];
      }
      return [...seen.values()];
    },
    createTool: (body) => request("POST", "/tool", body),
    updateTool: (id, body) => request("PATCH", `/tool/${encodeURIComponent(id)}`, body),
    getAssistant: (id) => request("GET", `/assistant/${encodeURIComponent(id)}`),
    updateAssistant: (id, body) => request("PATCH", `/assistant/${encodeURIComponent(id)}`, body),
    async labelAssistantVersion(id, version, body) {
      await request("PATCH", `/assistant/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, body);
    },
  };
}
