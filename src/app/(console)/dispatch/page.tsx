import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AlarmClockIcon, ArrowUpRightIcon, CheckCircle2Icon, KeyRoundIcon, MapPinIcon, PhoneIcon } from "lucide-react";
import { CallbackActions, DispatchActions } from "@/components/console/board-actions";
import { SeedTag, URGENCY_RAIL, UrgencyBadge, VulnerableList } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyState, ListSkeleton, PageHeader, PhoneLink } from "@/components/console/page";
import { cn } from "@/lib/utils";
import type { BoardItem } from "@/server/console/board";
import { loadBoard } from "@/server/console/data";
import { formatClock, formatElapsed, formatPhone, formatTimestamp } from "@/server/console/format";

export const metadata: Metadata = { title: "Dispatch" };

export default function DispatchPage() {
  return (
    <>
      <PageHeader
        title="Dispatch"
        description="Open priority requests and callbacks. Most urgent first, then longest waiting."
      />
      <Suspense fallback={<ListSkeleton rows={3} height="h-40" />}>
        <Board />
      </Suspense>
    </>
  );
}

async function Board() {
  const { items, now, tz } = await loadBoard();
  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2Icon}
        title="Nothing waiting"
        description="No open priority dispatches or callbacks. New requests from calls appear here within a few seconds."
      />
    );
  }
  const overdue = items.filter((i) => i.overdue).length;
  return (
    <section aria-label="Priority board" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{items.length}</span> open
        {overdue > 0 && (
          <>
            {" · "}
            <span className="font-medium text-safety-ink">{overdue} past SLA</span>
          </>
        )}
      </p>
      <FreshScope scope="board" ids={items.map((i) => `${i.kind}:${i.id}`)}>
        <ul className="space-y-3">
          {items.map((item) => (
            <FreshItem key={`${item.kind}:${item.id}`} id={`${item.kind}:${item.id}`} className="rounded-xl">
              <BoardCard item={item} now={now} tz={tz} />
            </FreshItem>
          ))}
        </ul>
      </FreshScope>
    </section>
  );
}

function BoardCard({ item, now, tz }: { item: BoardItem; now: Date; tz: string }) {
  const phone = formatPhone(item.callerPhone);
  const address = item.address;
  return (
    <article
      className={cn(
        "relative flex overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10",
        item.overdue && "ring-safety/40",
        item.status === "acknowledged" && "bg-card/60",
      )}
    >
      <div className={cn("w-1 shrink-0", URGENCY_RAIL[item.urgency ?? "none"])} aria-hidden />
      <div className="grid min-w-0 flex-1 gap-x-8 gap-y-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto]">
        {/* Who and where */}
        <div className="min-w-0 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <UrgencyBadge urgency={item.urgency} />
            <span className="font-medium">{item.title}</span>
            <SeedTag show={item.isDemoSeed} />
          </div>
          <div className="space-y-1">
            <p className="text-base font-semibold tracking-tight">{item.callerName ?? "Name not given"}</p>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <PhoneIcon className="size-3.5" aria-hidden />
              <PhoneLink e164={item.callerPhone} display={phone} />
            </p>
          </div>
          {address && (
            <div className="space-y-1">
              <p className="flex items-start gap-1.5">
                <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  {[address.line1, address.unit && `Unit ${address.unit}`].filter(Boolean).join(", ") || "Street not given"}
                  {(address.city || address.zip) && (
                    <span className="text-muted-foreground"> · {[address.city, address.zip].filter(Boolean).join(" ")}</span>
                  )}
                </span>
              </p>
              {address.accessNotes && (
                <p className="flex items-start gap-1.5 text-muted-foreground">
                  <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{address.accessNotes}</span>
                </p>
              )}
            </div>
          )}
          <VulnerableList items={item.vulnerable} />
        </div>

        {/* Why */}
        <div className="min-w-0 space-y-2">
          {item.issue && <p className="font-medium">{item.issue}</p>}
          {item.reasons.length > 0 ? (
            <ul className="space-y-1 text-muted-foreground">
              {item.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No triage on this call.</p>
          )}
          {item.vapiCallId && (
            <Link
              href={`/calls/${encodeURIComponent(item.vapiCallId)}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View call
              <ArrowUpRightIcon className="size-3" aria-hidden />
            </Link>
          )}
        </div>

        {/* When and what next */}
        <div className="flex flex-row items-end justify-between gap-4 border-t pt-3 md:col-span-2 xl:col-span-1 xl:flex-col xl:items-end xl:border-t-0 xl:pt-0">
          <div className="space-y-0.5 xl:text-right">
            <p
              className={cn(
                "flex items-center gap-1.5 text-base font-semibold tabular-nums xl:justify-end",
                item.overdue && "text-safety-ink",
              )}
            >
              {item.overdue && <AlarmClockIcon className="size-4" aria-hidden />}
              {formatElapsed(item.ageMs)}
              <span className="sr-only"> waiting</span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {item.overdue
                ? `${formatElapsed(item.ageMs - item.slaMinutes * 60_000)} past ${item.slaMinutes}m SLA`
                : item.status === "acknowledged" && item.acknowledgedAt
                  ? `Acknowledged ${formatClock(item.acknowledgedAt, tz)}`
                  : `SLA ${item.slaMinutes}m`}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">Logged {formatTimestamp(item.createdAt, tz, now)}</p>
          </div>
          {item.kind === "dispatch" ? <DispatchActions id={item.id} status={item.status} /> : <CallbackActions id={item.id} />}
        </div>
      </div>
    </article>
  );
}
