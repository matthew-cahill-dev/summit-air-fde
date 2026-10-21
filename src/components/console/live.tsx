"use client";

import { createContext, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/** Re-fetches the server components on an interval while the tab is visible. */
export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [visible, setVisible] = useState(true);

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

  return (
    <span
      className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground"
      title={visible ? `Refreshing every ${intervalMs / 1000} seconds` : "Paused while this tab is hidden"}
      aria-live="polite"
    >
      <span className="relative flex size-2">
        {visible && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />}
        <span className={cn("relative inline-flex size-2 rounded-full", visible ? "bg-success" : "bg-muted-foreground/50")} />
      </span>
      {visible ? "Live" : "Paused"}
    </span>
  );
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
