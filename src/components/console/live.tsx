"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

// --- A shared one-second clock ------------------------------------------------------
// One interval for every ticking element (SLA countdowns, "updated 3s ago"). The server
// snapshot is the server's own "now", so the first client render matches the markup.
let clockNow = typeof window === "undefined" ? 0 : Date.now();
const clockSubs = new Set<() => void>();
let clockTimer: number | null = null;

function subscribeClock(cb: () => void) {
  clockSubs.add(cb);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockSubs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    clockSubs.delete(cb);
    if (clockSubs.size === 0 && clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** Milliseconds since the epoch, re-rendering once a second. `serverNow` is used for SSR and hydration. */
export function useNow(serverNow = 0): number {
  return useSyncExternalStore(subscribeClock, () => clockNow, () => serverNow);
}

/**
 * Re-fetches the server components on an interval while the tab is visible, and shows when the
 * data last arrived ("Live · updated 3s ago"). The refresh is a transition: the old screen stays
 * until the new one is ready, so polling never flickers or shifts the layout.
 */
export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [visible, setVisible] = useState(true);
  const now = useNow();
  // A finished refresh (pending true → false) is "updated now". Derived during render, not in an effect.
  const [prevPending, setPrevPending] = useState(pending);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  if (prevPending !== pending) {
    setPrevPending(pending);
    if (!pending) setUpdatedAt(now);
  }

  useEffect(() => {
    const onVisibility = () => {
      const isVisible = document.visibilityState === "visible";
      setVisible(isVisible);
      // Catch up immediately when the operator comes back to the tab.
      if (isVisible) startTransition(() => router.refresh());
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [router, intervalMs]);

  const ago = updatedAt !== null && now > 0 ? updatedAgo(now - updatedAt) : "just now";
  return (
    <span
      className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground"
      title={visible ? `Refreshing every ${intervalMs / 1000} seconds` : "Paused while this tab is hidden"}
    >
      <span className="relative flex size-2" aria-hidden>
        {visible && <span className="animate-live absolute inline-flex size-full rounded-full bg-success" />}
        <span className={cn("relative inline-flex size-2 rounded-full", visible ? "bg-success" : "bg-muted-foreground/50")} />
      </span>
      <span className="text-foreground">{visible ? "Live" : "Paused"}</span>
      <span className="tabular hidden w-28 sm:inline">· updated {ago}</span>
    </span>
  );
}

/** "just now", "4s ago", "2m ago". */
export function updatedAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Faster polling while mounted (an in-progress call's page): no UI of its own. */
export function FastPoll({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}

// --- New-row highlighting -------------------------------------------------------
// Ids already shown per list survive refreshes and client navigation (module scope),
// so only rows that arrive after the list was first seen get highlighted.
const seenByScope = new Map<string, Set<string>>();
const FreshContext = createContext<ReadonlySet<string>>(new Set());

export function FreshScope({ scope, ids, children }: { scope: string; ids: string[]; children: ReactNode }) {
  const key = ids.join("|");
  const fresh = useMemo(() => {
    const seen = seenByScope.get(scope);
    return new Set(seen ? key.split("|").filter((id) => id && !seen.has(id)) : []);
  }, [scope, key]);

  useEffect(() => {
    const seen = seenByScope.get(scope) ?? new Set<string>();
    for (const id of key.split("|")) if (id) seen.add(id);
    seenByScope.set(scope, seen);
  }, [scope, key]);

  return <FreshContext.Provider value={fresh}>{children}</FreshContext.Provider>;
}

type FreshProps = { id: string; className?: string; children: ReactNode };

export function FreshRow({ id, className, children }: FreshProps) {
  const isFresh = useContext(FreshContext).has(id);
  return (
    <tr data-slot="table-row" data-fresh={isFresh || undefined} className={cn(className, isFresh && "animate-fresh")}>
      {children}
    </tr>
  );
}

export function FreshItem({ id, className, children }: FreshProps) {
  const isFresh = useContext(FreshContext).has(id);
  return (
    <li data-fresh={isFresh || undefined} className={cn(className, isFresh && "animate-fresh")}>
      {children}
    </li>
  );
}
