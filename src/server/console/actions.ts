// Board actions behind the console's Server Actions. Framework-free so tests can
// call them with the test database; src/app/(console)/actions.ts adds auth + refresh.
import { z } from "zod";
import { logEvent } from "@/server/lib/log";
import type { Repositories } from "@/server/repositories";

export type BoardActionResult = { ok: true; status: string } | { ok: false; error: string };

const idSchema = z.uuid();

async function run(
  action: string,
  rawId: unknown,
  update: (id: string) => Promise<{ id: string; status: string } | null>,
  conflict: string,
): Promise<BoardActionResult> {
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) return { ok: false, error: "Unknown request." };
  try {
    const row = await update(parsed.data);
    logEvent("console_action", { action, id: parsed.data, applied: Boolean(row) });
    return row ? { ok: true, status: row.status } : { ok: false, error: conflict };
  } catch (err) {
    logEvent("console_action_failed", { action, id: parsed.data, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Couldn't save that. Try again." };
  }
}

type Deps = { repos: Pick<Repositories, "dispatch" | "callbacks">; now?: Date };

export function acknowledgeDispatch(id: unknown, deps: Deps): Promise<BoardActionResult> {
  return run("dispatch_acknowledge", id, (v) => deps.repos.dispatch.acknowledge(v, deps.now ?? new Date()), "Already acknowledged or resolved.");
}

export function resolveDispatch(id: unknown, deps: Deps): Promise<BoardActionResult> {
  return run("dispatch_resolve", id, (v) => deps.repos.dispatch.resolve(v, deps.now ?? new Date()), "Already resolved.");
}

export function completeCallback(id: unknown, deps: Deps): Promise<BoardActionResult> {
  return run("callback_done", id, (v) => deps.repos.callbacks.markDone(v, deps.now ?? new Date()), "Already marked done.");
}
