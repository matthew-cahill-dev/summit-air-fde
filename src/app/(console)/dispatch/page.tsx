import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  ClockIcon,
  FileTextIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MapPinIcon,
  PhoneIcon,
  type LucideIcon,
} from "lucide-react";
import { CallbackActions, DispatchActions, OptimisticCard } from "@/components/console/board-actions";
import { AutoDetectedBadge, OutcomeBadge, PropertyBadge, SeedTag, URGENCY_RAIL, UrgencyBadge, VulnerableList } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyIllustration, ListSkeleton, PageHeader, PhoneLink } from "@/components/console/page";
import { SlaClock } from "@/components/console/sla-clock";
import { TONE_FILL, URGENCY_TONE } from "@/components/console/tone";
import { cn } from "@/lib/utils";
import { boardSummary, groupBoard, type BoardItem } from "@/server/console/board";
import { loadBoard } from "@/server/console/data";
import { formatPhone, formatTimestamp } from "@/server/console/format";

export const metadata: Metadata = { title: "Dispatch" };

export default function DispatchPage() {
  return (
    <>
      <PageHeader title="Dispatch board" description="Open priority requests and callbacks: most urgent first, then longest waiting." />
      <Suspense fallback={<ListSkeleton rows={3} height="h-44" />}>
        <Board />
      </Suspense>
    </>
  );
}

async function Board() {
  const { items, now, tz } = await loadBoard();
  const summary = boardSummary(items);
  return (
    <div className="space-y-6">
      <SummaryBar summary={summary} />
      {items.length === 0 ? (
        <EmptyIllustration
          kind="calm"
          title="All clear"
          description="No open priority dispatches or callbacks. New requests from calls appear here within a few seconds."
        />
      ) : (
        <FreshScope scope="board" ids={items.map((i) => `${i.kind}:${i.id}`)}>
          <div className="space-y-8">
            {groupBoard(items).map((group) => (
              <section key={group.key} aria-labelledby={`group-${group.key}`} className="space-y-3">
                <h2 id={`group-${group.key}`} className="flex items-center gap-2 text-sm font-semibold">
                  <span className={cn("size-2 rounded-full", group.key === "other" ? TONE_FILL.callback : TONE_FILL[URGENCY_TONE[group.key]])} aria-hidden />
                  {group.label}
                  <span className="tabular font-normal text-muted-foreground">{group.items.length}</span>
                </h2>
                <ul className="space-y-3">
                  {group.items.map((item) => (
                    <FreshItem key={`${item.kind}:${item.id}`} id={`${item.kind}:${item.id}`} className="rounded-2xl">
                      <OptimisticCard>
                        <BoardCard item={item} now={now} tz={tz} />
                      </OptimisticCard>
                    </FreshItem>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </FreshScope>
      )}
    </div>
  );
}

function SummaryBar({ summary }: { summary: ReturnType<typeof boardSummary> }) {
  const tiles: Array<{ label: string; value: number; tone?: string; alert?: boolean }> = [
    { label: "Open", value: summary.open },
    { label: "Overdue", value: summary.overdue, tone: "text-safety-ink", alert: summary.overdue > 0 },
    { label: "Safety stops", value: summary.safety, tone: "text-safety-ink", alert: summary.safety > 0 },
    { label: "Emergencies", value: summary.emergencies, tone: "text-emergency-ink" },
    { label: "Coverage checks", value: summary.coverage, tone: "text-coverage-ink" },
    { label: "Callbacks", value: summary.callbacks, tone: "text-callback-ink" },
  ];
  return (
    <dl className="shadow-card grid grid-cols-3 divide-x divide-y rounded-2xl bg-card ring-1 ring-foreground/8 md:grid-cols-6 md:divide-y-0">
      {tiles.map((t) => (
        <div key={t.label} className={cn("space-y-0.5 px-5 py-3.5", t.alert && "bg-safety-soft/60")}>
          <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
          <dd className={cn("tabular text-2xl font-semibold tracking-tight", t.value > 0 ? t.tone : "text-muted-foreground/60")}>{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Line({ icon: Icon, children, muted }: { icon: LucideIcon; children: ReactNode; muted?: boolean }) {
  return (
    <p className={cn("flex items-start gap-2", muted && "text-muted-foreground")}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function BoardCard({ item, now, tz }: { item: BoardItem; now: Date; tz: string }) {
  const phone = formatPhone(item.callerPhone);
  const address = item.address;
  const rail = URGENCY_RAIL[item.urgency ?? "none"];
  return (
    <article
      className={cn(
        "shadow-card relative flex overflow-hidden rounded-2xl bg-card text-sm ring-1 ring-foreground/8 transition-shadow duration-200 hover:shadow-raised",
        item.overdue && "ring-safety/40",
      )}
    >
      <div className={cn("w-1.5 shrink-0", item.coverageCheck ? TONE_FILL.coverage : item.kind === "callback" && !item.urgency ? TONE_FILL.callback : rail)} aria-hidden />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          {(item.urgency || item.kind === "dispatch") && <UrgencyBadge urgency={item.urgency} />}
          {item.coverageCheck && <OutcomeBadge outcome="coverage_check" />}
          <span className="font-semibold">{item.title}</span>
          {item.autoDetected && <AutoDetectedBadge />}
          <PropertyBadge property={item.property} />
          <SeedTag show={item.isDemoSeed} />
          <span className="tabular ml-auto text-xs text-muted-foreground">Logged {formatTimestamp(item.createdAt, tz, now)}</span>
        </header>
        <div className="grid gap-x-8 gap-y-4 px-5 py-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_15rem]">
          {/* Who and where */}
          <div className="min-w-0 space-y-2.5">
            <div>
              <p className="text-base font-semibold tracking-tight">{item.callerName ?? "Name not given"}</p>
              <Line icon={PhoneIcon} muted>
                <PhoneLink e164={item.callerPhone} display={phone} />
              </Line>
            </div>
            {address && (
              <div className="space-y-1">
                <Line icon={MapPinIcon}>
                  {[address.line1, address.unit && `Unit ${address.unit}`].filter(Boolean).join(", ") || "Street not given"}
                  {(address.city || address.zip) && <span className="text-muted-foreground"> · {[address.city, address.zip].filter(Boolean).join(" ")}</span>}
                </Line>
                {address.accessNotes && (
                  <Line icon={KeyRoundIcon} muted>
                    {address.accessNotes}
                  </Line>
                )}
              </div>
            )}
            <VulnerableList items={item.vulnerable} />
          </div>

          {/* Why */}
          <div className="min-w-0 space-y-2.5">
            {item.issue && <p className="font-medium text-pretty">{item.issue}</p>}
            {item.language && <Line icon={LanguagesIcon} muted>Call back in {item.language}</Line>}
            {item.preferredTime && (
              <Line icon={ClockIcon}>
                <span className="font-medium">Prefers a call {item.preferredTime}</span>
              </Line>
            )}
            {item.reasons.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {item.reasons.map((r) => (
                  <li key={r} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                    <span className="text-pretty">{r}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.notes && (
              <details className="group rounded-lg bg-muted/60 px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden">
                  <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  Technician notes
                  <span className="ml-auto text-muted-foreground group-open:hidden">Show</span>
                  <span className="ml-auto hidden text-muted-foreground group-open:inline">Hide</span>
                </summary>
                <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">{item.notes}</p>
              </details>
            )}
            {item.vapiCallId && (
              <Link
                href={`/calls/${encodeURIComponent(item.vapiCallId)}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink underline-offset-4 hover:underline"
              >
                View call
                <ArrowUpRightIcon className="size-3" aria-hidden />
              </Link>
            )}
          </div>

          {/* When and what next */}
          <div className="flex flex-col justify-between gap-4 border-t pt-3 md:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
            <SlaClock
              createdAt={item.createdAt.toISOString()}
              slaMinutes={item.slaMinutes}
              acknowledgedAt={item.status === "acknowledged" && item.acknowledgedAt ? item.acknowledgedAt.toISOString() : null}
              serverNow={now.toISOString()}
            />
            {item.kind === "dispatch" ? <DispatchActions id={item.id} status={item.status} /> : <CallbackActions id={item.id} />}
          </div>
        </div>
      </div>
    </article>
  );
}
