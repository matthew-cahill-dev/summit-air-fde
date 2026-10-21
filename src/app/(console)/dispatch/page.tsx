import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DispatchBoard, STAGE_HELP } from "@/components/console/dispatch-board";
import { ListSkeleton, PageHeader } from "@/components/console/page";
import { TONE_FILL } from "@/components/console/tone";
import { cn } from "@/lib/utils";
import { boardSummary, filterBoard, STAGE_LABEL, type BoardKind, type BoardTab } from "@/server/console/board";
import { loadBoard, type BoardRange } from "@/server/console/data";

export const metadata: Metadata = { title: "Dispatch" };

const TABS: Array<{ tab: BoardTab; label: string }> = [
  { tab: "open", label: "Open" },
  { tab: "called_back", label: STAGE_LABEL.called_back },
  { tab: "resolved", label: STAGE_LABEL.resolved },
];

const KINDS: Array<{ kind: BoardKind; label: string; dot?: string; help: string }> = [
  { kind: "all", label: "Everything", help: "Every priority request and callback" },
  { kind: "safety", label: "Safety stops", dot: TONE_FILL.safety, help: "Gas, carbon monoxide or smoke: the caller was told to leave and call 911" },
  { kind: "priority", label: "Emergencies", dot: TONE_FILL.emergency, help: "Priority dispatch: Summit Air's policy is an on-call callback within 15 minutes" },
  { kind: "callbacks", label: "Callbacks", dot: TONE_FILL.callback, help: "Office follow-ups: reschedules, questions, language callbacks, people who asked for a person" },
  { kind: "coverage", label: "Coverage checks", dot: TONE_FILL.coverage, help: "Bronx or Staten Island addresses the office must confirm before booking" },
];

const one = <T extends string>(v: string | string[] | undefined, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export default function DispatchPage({ searchParams }: PageProps<"/dispatch">) {
  return (
    <>
      <PageHeader
        title="Dispatch board"
        description="Priority requests and callbacks from calls. New → Called back (stops the SLA clock) → Resolved with an outcome."
      />
      <Suspense fallback={<ListSkeleton rows={3} height="h-44" />}>
        <Board searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Board({ searchParams }: { searchParams: PageProps<"/dispatch">["searchParams"] }) {
  const sp = await searchParams;
  const tab = one(sp.tab, ["open", "called_back", "resolved"] as const, "open");
  const kind = one(sp.kind, ["all", "safety", "priority", "callbacks", "coverage"] as const, "all");
  const range = one(sp.range, ["today", "7d"] as const, "today") as BoardRange;
  const { all, items, now, tz } = await loadBoard({ tab, kind, range });
  const summary = boardSummary(all);
  const href = (patch: Partial<{ tab: BoardTab; kind: BoardKind; range: BoardRange }>) => {
    const q = new URLSearchParams({ tab, kind, range, ...patch });
    if (q.get("kind") === "all") q.delete("kind");
    if (q.get("range") === "today") q.delete("range");
    if (q.get("tab") === "open") q.delete("tab");
    const s = q.toString();
    return `/dispatch${s ? `?${s}` : ""}`;
  };

  const tiles = [
    { label: "Open", value: summary.open, link: href({ tab: "open", kind: "all" }), help: "Everything not resolved yet (new and called back)" },
    { label: "Overdue", value: summary.overdue, tone: "text-safety-ink", alert: summary.overdue > 0, link: href({ tab: "open", kind: "all" }), help: "New items past their callback SLA (15 minutes for emergencies, 2 hours for office callbacks)" },
    { label: "Safety stops", value: summary.safety, tone: "text-safety-ink", alert: summary.safety > 0, link: href({ tab: "open", kind: "safety" }), help: KINDS[1].help },
    { label: "Emergencies", value: summary.emergencies, tone: "text-emergency-ink", link: href({ tab: "open", kind: "priority" }), help: KINDS[2].help },
    { label: "Coverage checks", value: summary.coverage, tone: "text-coverage-ink", link: href({ tab: "open", kind: "coverage" }), help: KINDS[4].help },
    { label: "Callbacks", value: summary.callbacks, tone: "text-callback-ink", link: href({ tab: "open", kind: "callbacks" }), help: KINDS[3].help },
  ];
  const tabCount = (t: BoardTab) => filterBoard(all, t, kind).length;

  return (
    <div className="space-y-5">
      <dl className="shadow-card grid grid-cols-3 divide-x divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/8 md:grid-cols-6 md:divide-y-0">
        {tiles.map((t) => (
          <Link key={t.label} href={t.link} title={t.help} className={cn("group space-y-0.5 px-5 py-3.5 transition-colors hover:bg-muted/50", t.alert && "bg-safety-soft/60")}>
            <dt className="text-xs font-medium text-muted-foreground group-hover:text-foreground">{t.label}</dt>
            <dd className={cn("tabular text-2xl font-semibold tracking-tight", t.value > 0 ? t.tone : "text-muted-foreground/60")}>{t.value}</dd>
          </Link>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <nav aria-label="Board status" className="flex rounded-xl bg-muted p-1">
          {TABS.map((t) => (
            <Link
              key={t.tab}
              href={href({ tab: t.tab })}
              aria-current={tab === t.tab ? "page" : undefined}
              title={t.tab === "open" ? STAGE_HELP.new : STAGE_HELP[t.tab]}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                tab === t.tab && "bg-card text-foreground shadow-card",
              )}
            >
              {t.label}
              <span className="tabular rounded-full bg-foreground/8 px-1.5 text-[11px] leading-5">{tabCount(t.tab)}</span>
            </Link>
          ))}
        </nav>
        {tab === "resolved" && (
          <div className="flex gap-1.5" role="group" aria-label="Resolved range">
            {(["today", "7d"] as const).map((r) => (
              <Link
                key={r}
                href={href({ range: r })}
                aria-current={range === r ? "true" : undefined}
                className={cn("inline-flex h-7 items-center rounded-full px-3 text-xs font-medium ring-1 ring-inset", range === r ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground")}
              >
                {r === "today" ? "Today" : "Last 7 days"}
              </Link>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind">
          {KINDS.map((k) => (
            <Link
              key={k.kind}
              href={href({ kind: k.kind })}
              title={k.help}
              aria-current={kind === k.kind ? "true" : undefined}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors", kind === k.kind ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground")}
            >
              {k.dot && <span className={cn("size-1.5 rounded-full", k.dot)} aria-hidden />}
              {k.label}
            </Link>
          ))}
        </div>
      </div>

      <DispatchBoard
        items={items}
        now={now.toISOString()}
        tz={tz}
        emptyTitle={tab === "open" ? "All clear" : tab === "called_back" ? "Nothing waiting to be resolved" : "Nothing resolved yet"}
        emptyText={
          tab === "open"
            ? "No new priority requests or callbacks. New ones from calls appear here within seconds."
            : tab === "called_back"
              ? "Items you've called back show here until you resolve them with an outcome."
              : range === "today"
                ? "Resolved items from today show here, with their outcome. Try the last 7 days."
                : "Nothing was resolved in the last 7 days."
        }
      />
    </div>
  );
}
