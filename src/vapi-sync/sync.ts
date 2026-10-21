// Plan + apply: upsert tools by name, update the assistant, report the published version.
// Keep this file free of path aliases: it is compiled for scripts/sync-vapi.ts.
import type { VapiApi } from "./api";
import { diffSubset, formatChanges, type Change } from "./diff";
import { toolName, type JsonObject } from "./render";

export type ToolPlan = { name: string; action: "create" | "update" | "unchanged"; id: string; changes: Change[] };

export type SyncResult = {
  dryRun: boolean;
  tools: ToolPlan[];
  assistantChanges: Change[];
  assistantUpdated: boolean;
  versionBefore: string | null;
  versionAfter: string | null;
  warnings: string[];
};

type Log = (line: string) => void;

const version = (a: JsonObject): string | null => (typeof a.latestVersion === "string" ? a.latestVersion : null);

/** Sort model.toolIds so ordering alone never counts as a change. */
function normalizeAssistant(a: JsonObject): JsonObject {
  const model = a.model as JsonObject | undefined;
  if (!model || !Array.isArray(model.toolIds)) return a;
  return { ...a, model: { ...model, toolIds: [...(model.toolIds as string[])].sort() } };
}

export async function syncVapi(opts: {
  api: VapiApi;
  assistantId: string;
  desiredTools: JsonObject[];
  /** Builds the full desired assistant once tool ids are known. */
  buildAssistant: (toolIds: string[]) => JsonObject;
  dryRun: boolean;
  log?: Log;
  versionLabel?: string;
}): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    log(`  ! ${w}`);
  };

  // 1. Tools, matched by name.
  const remote = await opts.api.listTools();
  const plans: ToolPlan[] = [];
  for (const desired of opts.desiredTools) {
    const name = toolName(desired);
    const matches = remote
      .filter((t) => toolName(t) === name)
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    if (matches.length > 1) warn(`${matches.length} Vapi tools are named "${name}"; updating the most recently updated (${matches[0].id}).`);
    const current = matches[0];

    if (!current) {
      let id = `<new:${name}>`;
      if (!opts.dryRun) {
        const created = await opts.api.createTool(desired);
        id = String(created.id);
        if (toolName(created) !== name) warn(`Vapi saved tool "${name}" as "${toolName(created)}"; the prompt refers to "${name}".`);
      }
      plans.push({ name, action: "create", id, changes: [] });
      log(`+ tool ${name}${opts.dryRun ? " (would create)" : ` created ${id}`}`);
      continue;
    }

    const changes = diffSubset(current, desired);
    const id = String(current.id);
    if (changes.length === 0) {
      plans.push({ name, action: "unchanged", id, changes });
      log(`= tool ${name} unchanged (${id})`);
      continue;
    }
    if (!opts.dryRun) {
      // `type` is immutable; Vapi's own gitops tool omits it from PATCH bodies.
      const patch = Object.fromEntries(Object.entries(desired).filter(([k]) => k !== "type"));
      const updated = await opts.api.updateTool(id, patch);
      if (toolName(updated) !== name) warn(`Vapi saved tool "${name}" as "${toolName(updated)}"; the prompt refers to "${name}".`);
    }
    plans.push({ name, action: "update", id, changes });
    log(`~ tool ${name}${opts.dryRun ? " (would update)" : " updated"} (${id})\n${formatChanges(changes)}`);
  }

  // 2. Assistant.
  const before = await opts.api.getAssistant(opts.assistantId);
  const desiredAssistant = normalizeAssistant(opts.buildAssistant(plans.map((p) => p.id)));
  const assistantChanges = diffSubset(normalizeAssistant(before), desiredAssistant);
  const versionBefore = version(before);
  let versionAfter = versionBefore;
  let assistantUpdated = false;

  if (assistantChanges.length === 0) {
    log(`= assistant ${opts.assistantId} unchanged (version ${versionBefore ?? "n/a"})`);
  } else if (opts.dryRun) {
    log(`~ assistant ${opts.assistantId} (would update)\n${formatChanges(assistantChanges)}`);
  } else {
    // Under Vapi versioning, an API PATCH with changed content publishes a new version immediately.
    await opts.api.updateAssistant(opts.assistantId, desiredAssistant);
    assistantUpdated = true;
    const after = await opts.api.getAssistant(opts.assistantId);
    versionAfter = version(after);
    log(`~ assistant ${opts.assistantId} updated\n${formatChanges(assistantChanges)}`);
    if (versionAfter === null) {
      warn("Vapi returned no latestVersion: this org may not be on assistant versioning. The update is live.");
    } else if (versionAfter === versionBefore) {
      warn(`Version is still ${versionAfter} after the update. Check the dashboard for an unpublished draft and publish it.`);
    } else if (opts.versionLabel) {
      try {
        await opts.api.labelAssistantVersion(opts.assistantId, versionAfter, {
          versionName: opts.versionLabel.slice(0, 80),
          versionDescription: `Synced by scripts/sync-vapi.ts: ${assistantChanges.map((c) => c.path).join(", ")}`.slice(0, 500),
        });
      } catch (err) {
        warn(`Couldn't label version ${versionAfter} (not fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { dryRun: opts.dryRun, tools: plans, assistantChanges, assistantUpdated, versionBefore, versionAfter, warnings };
}
