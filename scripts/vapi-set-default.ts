// `npm run vapi:set-default -- [--variant <model>] [--voice <voice>] [--endpointing <preset>]`
// `npm run vapi:set-default -- --show`
// Records which overlays a plain `npm run vapi:sync` publishes, in vapi/assistant.json `_defaults`.
// Local file change only: nothing is sent to Vapi until you run `npm run vapi:sync`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSelection } from "../src/vapi-sync/variants";

const VAPI_DIR = join(process.cwd(), "vapi");
const FILE = join(VAPI_DIR, "assistant.json");
const KINDS = { variant: "model", voice: "voice", endpointing: "endpointing" } as const;

const available = (dir: string) =>
  readdirSync(join(VAPI_DIR, "variants", dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();

function main() {
  const argv = process.argv.slice(2);
  const text = readFileSync(FILE, "utf8");
  const assistant = JSON.parse(text) as Record<string, unknown>;
  const current = defaultSelection(assistant);

  const changes: Partial<Record<keyof typeof KINDS, string>> = {};
  for (const flag of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
    const i = argv.indexOf(`--${flag}`);
    if (i < 0) continue;
    const name = argv[i + 1];
    if (!name || name.startsWith("--")) throw new Error(`--${flag} needs a value`);
    if (!existsSync(join(VAPI_DIR, "variants", KINDS[flag], `${name}.json`))) {
      throw new Error(`Unknown --${flag} "${name}". Available: ${available(KINDS[flag]).join(", ")}`);
    }
    changes[flag] = name;
  }

  const show = (label: string, sel: { variant: string; voice: string; endpointing: string }) =>
    console.log(`${label}: --variant ${sel.variant} --voice ${sel.voice} --endpointing ${sel.endpointing}`);

  if (argv.includes("--show") || Object.keys(changes).length === 0) {
    show("Defaults (a plain `npm run vapi:sync` publishes)", current);
    for (const flag of Object.keys(KINDS) as Array<keyof typeof KINDS>) console.log(`  ${flag.padEnd(11)} available: ${available(KINDS[flag]).join(", ")}`);
    if (Object.keys(changes).length === 0 && !argv.includes("--show")) console.log("\nPass --variant, --voice and/or --endpointing to change them.");
    return;
  }

  const next = { variant: current.variant, voice: current.voice, endpointing: current.endpointing, ...changes };
  // Rewrite with _defaults right after _comments; everything else keeps its order.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(assistant)) {
    if (k === "_defaults") continue;
    out[k] = v;
    if (k === "_comments") out._defaults = next;
  }
  if (!("_defaults" in out)) Object.assign(out, { _defaults: next });
  writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
  show("Was", current);
  show("Now", next);
  console.log("\nUpdated vapi/assistant.json. Preview with `npm run vapi:sync -- --dry-run`, then publish with `npm run vapi:sync`.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
