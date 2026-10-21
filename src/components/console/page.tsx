import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="present-hide text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </header>
  );
}

/** Empty state with a small inline illustration (no assets): calm board, empty inbox, empty calendar. */
export function EmptyIllustration({ kind, title, description }: { kind: "calm" | "inbox" | "calendar" | "phone"; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card/40 px-6 py-16 text-center">
      <svg viewBox="0 0 120 80" className="mb-4 h-20 w-32" aria-hidden>
        <ellipse cx="60" cy="70" rx="44" ry="5" className="fill-muted" />
        {kind === "calm" && (
          <>
            <path d="M18 62 44 26l12 16 10-12 36 32Z" className="fill-brand-soft stroke-brand" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="88" cy="20" r="7" className="fill-urgent-soft stroke-urgent" strokeWidth="1.5" />
            <path d="m50 50 6 6 12-13" className="stroke-success" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {kind === "inbox" && (
          <>
            <rect x="28" y="22" width="64" height="40" rx="8" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M28 46h18l4 6h20l4-6h18" className="stroke-brand" strokeWidth="1.5" fill="none" />
          </>
        )}
        {kind === "calendar" && (
          <>
            <rect x="30" y="18" width="60" height="46" rx="8" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M30 32h60" className="stroke-border" strokeWidth="1.5" />
            <rect x="40" y="40" width="10" height="8" rx="2" className="fill-brand-soft" />
            <rect x="55" y="40" width="10" height="8" rx="2" className="fill-muted" />
            <rect x="70" y="40" width="10" height="8" rx="2" className="fill-muted" />
          </>
        )}
        {kind === "phone" && (
          <>
            <rect x="44" y="12" width="32" height="54" rx="7" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M54 58h12" className="stroke-border" strokeWidth="2" strokeLinecap="round" />
            <path d="M84 26a10 10 0 0 1 0 14M90 20a18 18 0 0 1 0 26" className="stroke-brand" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </>
        )}
      </svg>
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground text-pretty">{description}</p>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <Empty className="border border-dashed py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ListSkeleton({ rows = 4, height = "h-28" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`${height} w-full rounded-2xl`} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-full rounded-none" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-6 border-t px-4 py-3.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Phone number as a tel: link, formatted for display. */
export function PhoneLink({ e164, display }: { e164: string | null; display: string | null }) {
  if (!e164 || !display) return <span className="text-muted-foreground">No number</span>;
  return (
    <a href={`tel:${e164}`} className="tabular-nums font-medium text-foreground underline-offset-4 hover:text-brand-ink hover:underline">
      {display}
    </a>
  );
}
