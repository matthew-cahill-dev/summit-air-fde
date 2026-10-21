// A/B variants for the assistant: model variants, voice variants and targets (a separate
// assistant, e.g. the speech-to-speech experiment). Each is a JSON overlay deep-merged onto
// vapi/assistant.json. Pure; scripts/sync-vapi.ts reads the files.
// Keep this file free of path aliases: it is compiled for scripts/sync-vapi.ts.
import type { JsonObject } from "./render";

export type Overlay = JsonObject;

const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep-merge `overlay` onto `base`. Objects merge key by key; arrays and scalars replace;
 * `null` deletes the key. Keys starting with "_" are documentation and ignored.
 * Returns the merged object and the dotted paths that were deleted.
 */
export function applyOverlay(base: JsonObject, overlay: Overlay, path = ""): { result: JsonObject; removed: string[] } {
  const result: JsonObject = { ...base };
  const removed: string[] = [];
  for (const [k, v] of Object.entries(overlay)) {
    if (k.startsWith("_")) continue;
    const p = path ? `${path}.${k}` : k;
    if (v === null) {
      if (k in result) removed.push(p);
      delete result[k];
    } else if (isObj(v) && isObj(result[k])) {
      const inner = applyOverlay(result[k] as JsonObject, v, p);
      result[k] = inner.result;
      removed.push(...inner.removed);
    } else {
      result[k] = v;
    }
  }
  return { result, removed };
}

/** Read a dotted path ("startSpeakingPlan.smartEndpointingPlan") from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

export type TargetConfig = {
  /** Env var holding this target's assistant id (VAPI_ASSISTANT_ID for the main assistant). */
  assistantIdEnv: string;
  /** Prompt section flags, e.g. { S2S: true }. */
  promptFlags: Record<string, boolean>;
  overlay: Overlay;
};

export const MAIN_TARGET: TargetConfig = { assistantIdEnv: "VAPI_ASSISTANT_ID", promptFlags: { S2S: false }, overlay: {} };

/** A target file: { "_comments", "assistantIdEnv", "promptFlags", "overlay" }. */
export function parseTarget(name: string, raw: unknown): TargetConfig {
  if (!isObj(raw)) throw new Error(`vapi/targets/${name}.json must be an object`);
  const env = raw.assistantIdEnv;
  if (typeof env !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(env)) throw new Error(`vapi/targets/${name}.json: assistantIdEnv must be an env var name`);
  if (env === "VAPI_ASSISTANT_ID") throw new Error(`vapi/targets/${name}.json must not point at the main assistant (VAPI_ASSISTANT_ID)`);
  const flags = isObj(raw.promptFlags) ? raw.promptFlags : {};
  return {
    assistantIdEnv: env,
    promptFlags: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v === true])),
    overlay: isObj(raw.overlay) ? raw.overlay : {},
  };
}

export type Selection = { variant: string; voice: string; target: string };

export const DEFAULT_SELECTION: Selection = { variant: "gpt-4.1", voice: "emma", target: "main" };

/** Apply model variant, then voice, then target, in that order (the target wins). */
export function composeAssistant(
  base: JsonObject,
  layers: { variant: Overlay; voice: Overlay; target: Overlay },
): { assistant: JsonObject; removed: string[] } {
  let current = base;
  const removed: string[] = [];
  for (const layer of [layers.variant, layers.voice, layers.target]) {
    const out = applyOverlay(current, layer);
    current = out.result;
    removed.push(...out.removed);
  }
  return { assistant: current, removed: [...new Set(removed)] };
}
