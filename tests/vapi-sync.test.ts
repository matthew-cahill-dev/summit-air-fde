import { describe, expect, it } from "vitest";
import type { VapiApi } from "@/vapi-sync/api";
import { diffSubset, lineDiff } from "@/vapi-sync/diff";
import type { JsonObject } from "@/vapi-sync/render";
import { syncVapi } from "@/vapi-sync/sync";

/** In-memory Vapi that behaves like the API: ids, server-side defaults, versions on content change. */
function fakeVapi(opts: { dropTransferName?: boolean; versioning?: boolean } = {}) {
  const tools = new Map<string, JsonObject>();
  const writes: string[] = [];
  let n = 0;
  let version = 3;
  let assistant: JsonObject = { id: "asst-1", orgId: "org", name: "Old", model: { provider: "openai", model: "gpt-4o", toolIds: [] }, latestVersion: "v3" };
  const api: VapiApi = {
    async listTools() {
      return [...tools.values()];
    },
    async createTool(body) {
      writes.push(`create ${(body.function as JsonObject | undefined)?.name ?? body.type}`);
      const id = `tool-${++n}`;
      let saved: JsonObject = { ...body, id, orgId: "org", createdAt: "2026-10-20", updatedAt: `t${n}`, async: body.async ?? false };
      if (opts.dropTransferName && body.type === "transferCall") {
        const { function: _f, ...rest } = saved;
        void _f;
        saved = rest;
      }
      tools.set(id, saved);
      return saved;
    },
    async updateTool(id, body) {
      writes.push(`update ${id}`);
      expect(body).not.toHaveProperty("type");
      const saved = { ...tools.get(id)!, ...body };
      tools.set(id, saved);
      return saved;
    },
    async getAssistant() {
      return structuredClone(assistant);
    },
    async updateAssistant(_id, body) {
      writes.push("update assistant");
      assistant = { ...assistant, ...body, latestVersion: opts.versioning === false ? null : `v${++version}` };
      return assistant;
    },
    async labelAssistantVersion(_id, v) {
      writes.push(`label ${v}`);
    },
  };
  return { api, writes, tools };
}

const desiredTools: JsonObject[] = [
  { type: "function", function: { name: "lookup_customer", description: "d1", parameters: { type: "object", properties: {} } }, server: { url: "https://x/api/vapi/tools" } },
  { type: "function", function: { name: "triage_issue", description: "d2", parameters: { type: "object", properties: {} } }, server: { url: "https://x/api/vapi/tools" } },
];
const buildAssistant = (prompt: string) => (toolIds: string[]) => ({
  name: "Summit Air Virtual Assistant",
  model: { provider: "openai", model: "gpt-4.1", messages: [{ role: "system", content: prompt }], toolIds },
});

describe("syncVapi", () => {
  it("dry run plans creates and the assistant diff without writing anything", async () => {
    const { api, writes } = fakeVapi();
    const log: string[] = [];
    const r = await syncVapi({ api, assistantId: "asst-1", desiredTools, buildAssistant: buildAssistant("v1\nline"), dryRun: true, log: (l) => log.push(l) });
    expect(writes).toEqual([]);
    expect(r.tools.map((t) => t.action)).toEqual(["create", "create"]);
    expect(r.assistantChanges.map((c) => c.path)).toEqual(expect.arrayContaining(["name", "model.model", "model.messages"]));
    expect(log.join("\n")).toContain("+ tool lookup_customer (would create)");
    expect(log.join("\n")).toContain('~ name: "Old" -> "Summit Air Virtual Assistant"');
  });

  it("applies, publishes a new version, labels it, and is idempotent on re-run", async () => {
    const { api, writes } = fakeVapi();
    const first = await syncVapi({ api, assistantId: "asst-1", desiredTools, buildAssistant: buildAssistant("v1"), dryRun: false, versionLabel: "sync test" });
    expect(writes).toEqual(["create lookup_customer", "create triage_issue", "update assistant", "label v4"]);
    expect(first).toMatchObject({ assistantUpdated: true, versionBefore: "v3", versionAfter: "v4", warnings: [] });

    writes.length = 0;
    const second = await syncVapi({ api, assistantId: "asst-1", desiredTools, buildAssistant: buildAssistant("v1"), dryRun: false });
    expect(writes).toEqual([]);
    expect(second).toMatchObject({ assistantUpdated: false, versionAfter: "v4" });
    expect(second.tools.every((t) => t.action === "unchanged")).toBe(true);

    // A prompt-only change patches just the assistant → v5.
    const third = await syncVapi({ api, assistantId: "asst-1", desiredTools, buildAssistant: buildAssistant("v2"), dryRun: false });
    expect(writes).toEqual(["update assistant"]);
    expect(third.versionAfter).toBe("v5");
  });

  it("updates a changed tool in place (no type in PATCH) and ignores server-added fields", async () => {
    const { api, writes } = fakeVapi();
    await syncVapi({ api, assistantId: "asst-1", desiredTools, buildAssistant: buildAssistant("v1"), dryRun: false });
    writes.length = 0;
    const changed = [{ ...desiredTools[0], function: { ...(desiredTools[0].function as JsonObject), description: "new" } }, desiredTools[1]];
    const r = await syncVapi({ api, assistantId: "asst-1", desiredTools: changed, buildAssistant: buildAssistant("v1"), dryRun: false });
    expect(writes).toEqual(["update tool-1"]);
    expect(r.tools[0]).toMatchObject({ action: "update", changes: [{ path: "function.description", before: "d1", after: "new" }] });
  });

  it("warns when Vapi drops the transfer tool's custom name, or versioning is off", async () => {
    const { api } = fakeVapi({ dropTransferName: true, versioning: false });
    const transfer = { type: "transferCall", function: { name: "transfer_to_on_call" }, destinations: [] };
    const r = await syncVapi({ api, assistantId: "asst-1", desiredTools: [transfer], buildAssistant: buildAssistant("v1"), dryRun: false });
    expect(r.warnings).toEqual([
      'Vapi saved tool "transfer_to_on_call" as "transferCall"; the prompt refers to "transfer_to_on_call".',
      "Vapi returned no latestVersion: this org may not be on assistant versioning. The update is live.",
    ]);
  });
});

describe("diff helpers", () => {
  it("diffSubset compares only desired keys", () => {
    expect(diffSubset({ a: 1, extra: true, nested: { b: 2, c: 3 } }, { a: 1, nested: { b: 2 } })).toEqual([]);
    expect(diffSubset({ list: [{ x: 1, y: 2 }] }, { list: [{ x: 1 }, { x: 2 }] })).toEqual([
      { path: "list", before: [{ x: 1, y: 2 }], after: [{ x: 1 }, { x: 2 }] },
    ]);
  });

  it("lineDiff shows changed lines with context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng", 1)).toBe("  ...\n  c\n- d\n+ D\n  e\n  ...");
  });
});
