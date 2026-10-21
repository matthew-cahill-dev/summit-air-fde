"use client";

import { useState, useTransition } from "react";
import { CheckCheckIcon, CheckIcon, HandIcon } from "lucide-react";
import {
  acknowledgeDispatchAction,
  completeCallbackAction,
  resolveDispatchAction,
} from "@/app/(console)/actions";
import { Button } from "@/components/ui/button";
import type { BoardActionResult } from "@/server/console/actions";

function useBoardAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<BoardActionResult>) =>
    startTransition(async () => {
      setError(null);
      try {
        const result = await fn();
        if (!result.ok) setError(result.error);
      } catch {
        setError("Couldn't reach the server. Try again.");
      }
    });
  return { pending, error, run };
}

export function DispatchActions({ id, status }: { id: string; status: "open" | "acknowledged" }) {
  const { pending, error, run } = useBoardAction();
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        {status === "open" && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => acknowledgeDispatchAction(id))}>
            <HandIcon data-icon="inline-start" />
            Acknowledge
          </Button>
        )}
        <Button size="sm" disabled={pending} onClick={() => run(() => resolveDispatchAction(id))}>
          <CheckCheckIcon data-icon="inline-start" />
          Resolve
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function CallbackActions({ id }: { id: string }) {
  const { pending, error, run } = useBoardAction();
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => completeCallbackAction(id))}>
        <CheckIcon data-icon="inline-start" />
        Mark done
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
