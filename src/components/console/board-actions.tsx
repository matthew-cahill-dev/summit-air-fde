"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { CheckCheckIcon, CheckIcon, HandIcon } from "lucide-react";
import {
  acknowledgeDispatchAction,
  completeCallbackAction,
  resolveDispatchAction,
} from "@/app/(console)/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BoardActionResult } from "@/server/console/actions";

// Optimistic board: a card reacts the moment it's clicked (acknowledged dims, resolved/done
// collapses away); the server refresh then confirms it. A failure puts the card back.
type CardState = "idle" | "acknowledged" | "gone";
const CardContext = createContext<{ state: CardState; set: (s: CardState) => void }>({ state: "idle", set: () => {} });

export function OptimisticCard({ children }: { children: ReactNode }) {
  const [state, set] = useState<CardState>("idle");
  return (
    <CardContext.Provider value={{ state, set }}>
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          state === "gone" ? "pointer-events-none grid-rows-[0fr] scale-[0.985] opacity-0" : "grid-rows-[1fr] opacity-100",
          state === "acknowledged" && "opacity-85",
        )}
        aria-hidden={state === "gone" || undefined}
      >
        {/* Clip only while collapsing, so card shadows and rounded corners aren't cut off. */}
        <div className={cn("min-h-0", state === "gone" && "overflow-hidden")}>{children}</div>
      </div>
    </CardContext.Provider>
  );
}

function useBoardAction() {
  const card = useContext(CardContext);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (optimistic: CardState, fn: () => Promise<BoardActionResult>) =>
    startTransition(async () => {
      setError(null);
      const before = card.state;
      card.set(optimistic);
      try {
        const result = await fn();
        if (!result.ok) {
          card.set(before);
          setError(result.error);
        }
      } catch {
        card.set(before);
        setError("Couldn't reach the server. Try again.");
      }
    });
  return { pending, error, run, state: card.state };
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  );
}

export function DispatchActions({ id, status }: { id: string; status: "open" | "acknowledged" }) {
  const { pending, error, run, state } = useBoardAction();
  const acknowledged = status === "acknowledged" || state === "acknowledged";
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <div className="flex gap-2">
        {acknowledged ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-success-ink">
            <HandIcon className="size-3.5" aria-hidden />
            Acknowledged
          </span>
        ) : (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run("acknowledged", () => acknowledgeDispatchAction(id))}>
            <HandIcon data-icon="inline-start" />
            Acknowledge
          </Button>
        )}
        <Button size="sm" disabled={pending && state === "gone"} onClick={() => run("gone", () => resolveDispatchAction(id))}>
          <CheckCheckIcon data-icon="inline-start" />
          Resolve
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function CallbackActions({ id }: { id: string }) {
  const { pending, error, run } = useBoardAction();
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run("gone", () => completeCallbackAction(id))}>
        <CheckIcon data-icon="inline-start" />
        Mark done
      </Button>
      <ErrorLine error={error} />
    </div>
  );
}
