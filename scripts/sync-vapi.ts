// `npm run vapi:sync -- [--dry-run | --offline] [--variant <model>] [--voice <voice>] [--target <target>]`
//   --offline  render the config locally and print it (no API key or network needed)
//   --dry-run  read current Vapi state and print a diff; change nothing
//   (default)  upsert tools by name, update the assistant (publishes a new version), print the version
//   --variant  model variant from vapi/variants/model/<name>.json
//   --voice    voice variant from vapi/variants/voice/<name>.json
//   --endpointing  end-of-turn preset from vapi/variants/endpointing/<name>.json (fast | safe)
//   Defaults for all three: vapi/assistant.json `_defaults` (set with `npm run vapi:set-default`).
//   --target   main (default: VAPI_ASSISTANT_ID, the assistant on the phone number) or a file in
//              vapi/targets/ (e.g. s2s: its own assistant id env var; created on first live sync).
//   Each run applies exactly the flags given, so a plain sync goes back to the defaults.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createVapiHttpApi } from "../src/vapi-sync/api";
import {
  buildDesiredAssistant,
  buildDesiredTools,
  renderSystemPrompt,
  type JsonObject,
  type SyncEnv,
} from "../src/vapi-sync/render";
import { syncVapi } from "../src/vapi-sync/sync";
import { composeAssistant, defaultSelection, getPath, MAIN_TARGET, parseTarget, type Selection, type TargetConfig } from "../src/vapi-sync/variants";

const VAPI_DIR = join(process.cwd(), "vapi");

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function env(name: string, required: boolean): string | undefined {
  const v = process.env[name]?.trim();
  if (required && !v) throw new Error(`${name} is not set (add it to .env)`);
  return v || undefined;
}

function overlayFile(kind: "model" | "voice" | "endpointing", name: string): JsonObject {
  const dir = join(VAPI_DIR, "variants", kind);
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) {
    const names = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    throw new Error(`Unknown ${kind === "model" ? "--variant" : `--${kind}`} "${name}". Available: ${names.join(", ")}`);
  }
  return readJson(path);
}

function targetConfig(name: string): TargetConfig {
  if (name === "main") return MAIN_TARGET;
  const path = join(VAPI_DIR, "targets", `${name}.json`);
  if (!existsSync(path)) throw new Error(`Unknown --target "${name}". Available: main, ${readdirSync(join(VAPI_DIR, "targets")).map((f) => f.replace(/\.json$/, "")).join(", ")}`);
  return parseTarget(name, readJson(path));
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const defaults = defaultSelection(readJson(join(VAPI_DIR, "assistant.json")));
  const selection: Selection = {
    variant: flagValue(argv, "--variant") ?? defaults.variant,
    voice: flagValue(argv, "--voice") ?? defaults.voice,
    endpointing: flagValue(argv, "--endpointing") ?? defaults.endpointing,
    target: flagValue(argv, "--target") ?? defaults.target,
  };
  const target = targetConfig(selection.target);
  const offline = args.has("--offline");
  const dryRun = offline || args.has("--dry-run");
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env; use the process environment.
  }

  const syncEnv: SyncEnv = {
    APP_URL: offline ? (env("APP_URL", false) ?? "https://example.invalid") : env("APP_URL", true)!,
    VAPI_CREDENTIAL_ID: offline ? (env("VAPI_CREDENTIAL_ID", false) ?? "<credential-id>") : env("VAPI_CREDENTIAL_ID", true)!,
    APP_TIMEZONE: env("APP_TIMEZONE", false) ?? "America/New_York",
    ON_CALL_TRANSFER_NUMBER: env("ON_CALL_TRANSFER_NUMBER", false),
  };
  if (syncEnv.ON_CALL_TRANSFER_NUMBER && !/^\+[1-9]\d{6,14}$/.test(syncEnv.ON_CALL_TRANSFER_NUMBER)) {
    throw new Error("ON_CALL_TRANSFER_NUMBER must be E.164, e.g. +17185550100");
  }
  if (!offline && !/^https:\/\//.test(syncEnv.APP_URL)) {
    console.warn(`! APP_URL (${syncEnv.APP_URL}) isn't https; Vapi can't reach a local URL.`);
  }

  const toolFiles = readdirSync(join(VAPI_DIR, "tools"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(join(VAPI_DIR, "tools", f)));
  const desiredTools = buildDesiredTools(toolFiles, syncEnv);
  const prompt = renderSystemPrompt(readFileSync(join(VAPI_DIR, "system-prompt.md"), "utf8"), {
    transferAvailable: Boolean(syncEnv.ON_CALL_TRANSFER_NUMBER),
    timeZone: syncEnv.APP_TIMEZONE,
    flags: target.promptFlags,
  });
  const assistantFile = readJson(join(VAPI_DIR, "assistant.json"));
  // Fields assistant.json used to set and no longer does: reported if the live assistant still has them.
  const removedFromLive = Array.isArray(assistantFile._removedFromLive) ? (assistantFile._removedFromLive as string[]) : [];
  const composed = composeAssistant(assistantFile, {
    variant: overlayFile("model", selection.variant),
    voice: overlayFile("voice", selection.voice),
    endpointing: overlayFile("endpointing", selection.endpointing),
    target: target.overlay,
  });
  const buildAssistant = (toolIds: string[]) => buildDesiredAssistant(composed.assistant, prompt, toolIds, syncEnv);
  console.log(
    `Selection: --target ${selection.target} --variant ${selection.variant} --voice ${selection.voice} --endpointing ${selection.endpointing}` +
      ` (defaults: ${defaults.variant} / ${defaults.voice} / ${defaults.endpointing})`,
  );

  console.log(
    `Transfer tool: ${syncEnv.ON_CALL_TRANSFER_NUMBER ? "attached" : "not attached (ON_CALL_TRANSFER_NUMBER unset; prompt falls back to callbacks)"}`,
  );

  if (offline) {
    console.log("\n--- system prompt ---\n" + prompt);
    console.log("--- tools ---\n" + desiredTools.map((t) => JSON.stringify(t)).join("\n"));
    const a = buildAssistant(desiredTools.map((t) => `<id:${(t.function as JsonObject | undefined)?.name ?? t.type}>`));
    const model = a.model as JsonObject;
    console.log("--- assistant (system prompt elided) ---\n" + JSON.stringify({ ...a, model: { ...model, messages: "<see above>" } }, null, 2));
    return;
  }

  const api = createVapiHttpApi(env("VAPI_API_KEY", true)!);
  const assistantId = env(target.assistantIdEnv, selection.target === "main") ?? null;
  if (assistantId === null) console.log(`${target.assistantIdEnv} is not set: the ${selection.target} assistant will be created on a live sync.`);
  console.log(dryRun ? "Dry run: reading Vapi state, no changes will be made.\n" : "Syncing to Vapi...\n");
  const result = await syncVapi({
    api,
    assistantId,
    desiredTools,
    buildAssistant,
    dryRun,
    // A path only counts as removed if the final (composed) config doesn't set it again.
    removedPaths: [...new Set([...removedFromLive, ...composed.removed])].filter((p) => getPath(composed.assistant, p) === undefined),
    log: (l) => console.log(l),
    versionLabel: `sync ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  });

  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const t of result.tools) counts[t.action]++;
  console.log(
    `\nTools: ${counts.create} ${dryRun ? "to create" : "created"}, ${counts.update} ${dryRun ? "to update" : "updated"}, ${counts.unchanged} unchanged.`,
  );
  if (dryRun) {
    console.log(`Assistant: ${result.assistantChanges.length ? `${result.assistantChanges.length} field(s) would change` : "no changes"}; current version ${result.versionBefore ?? "n/a"}.`);
  } else {
    console.log(
      result.assistantUpdated
        ? `Assistant updated: version ${result.versionBefore ?? "n/a"} -> ${result.versionAfter ?? "n/a"} (live).`
        : `Assistant unchanged: version ${result.versionAfter ?? "n/a"}.`,
    );
  }
  if (result.createdAssistantId) {
    console.log(`\nCreated the ${selection.target} assistant. Add this line to .env, then sync again to update it:\n${target.assistantIdEnv}=${result.createdAssistantId}`);
  }
  if (result.warnings.length) console.log(`\n${result.warnings.length} warning(s) above.`);
}

main().catch((err) => {
  console.error(`sync-vapi failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
