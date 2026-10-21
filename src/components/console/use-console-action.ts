"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { undoConsoleAction } from "@/app/(console)/actions";
import type { ConsoleActionResult } from "@/server/console/actions";
import { useOperatorName } from "./operator";

/**
 * Runs a console action with the operator's name, then a toast: success with a 5-second Undo, or
 * the error. `onDone` lets a card animate optimistically; `onUndone` restores it.
 */
export function useConsoleAction() {
  const name = useOperatorName();
  const [pending, startTransition] = useTransition();
  const run = (
    fn: (by: string) => Promise<ConsoleActionResult>,
    opts: { optimistic?: () => void; rollback?: () => void; after?: (r: Extract<ConsoleActionResult, { ok: true }>) => void } = {},
  ) => {
    if (!name) {
      toast.warning("Add your name first", { description: "Top right, so actions show who did them." });
      document.getElementById("operator-name")?.focus();
      return;
    }
    startTransition(async () => {
      opts.optimistic?.();
      let result: ConsoleActionResult;
      try {
        result = await fn(name);
      } catch {
        result = { ok: false, error: "Couldn't reach the server. Try again." };
      }
      if (!result.ok) {
        opts.rollback?.();
        toast.error(result.error);
        return;
      }
      opts.after?.(result);
      const undo = result.undo;
      toast.success(result.message, {
        duration: 5000,
        action: undo
          ? {
              label: "Undo",
              onClick: async () => {
                const r = await undoConsoleAction(undo);
                if (r.ok) {
                  opts.rollback?.();
                  toast(r.message);
                } else toast.error(r.error);
              },
            }
          : undefined,
      });
    });
  };
  return { run, pending, name };
}
