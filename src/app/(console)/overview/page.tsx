import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  CalendarCheckIcon,
  CheckCheckIcon,
  HandIcon,
  PhoneCallIcon,
  PhoneIncomingIcon,
  SirenIcon,
  type LucideIcon,
} from "lucide-react";
import { SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyIllustration, PageHeader } from "@/components/console/page";
import { OUTCOME_TONE, TONE_CHIP, TONE_FILL, TONE_TEXT, type Tone } from "@/components/console/tone";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dayDelta, outcomeBreakdown, sparkPath, type Delta } from "@/server/console/charts";
import { loadOverview } from "@/server/console/data";
import { callbackReasonLabel, formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import { OUTCOME_LABEL, type CallOutcome } from "@/server/console/outcome";
import type { ActivityKind, ActivityRow, DailyPoint, OverviewStats } from "@/server/repositories";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Today so far (America/New_York), and the latest activity." />
      <Suspense fallback={<OverviewSkeleton />}>
        <Overview />
      </Suspense>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

async function Overview() {
  const { stats, activity, series, outcomes, now, tz } = await loadOverview();
  return (
    <div className="space-y-6">
      <Kpis stats={stats} series={series} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <OutcomeMix outcomes={outcomes} />
        <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8">
          <h2 className="border-b px-5 py-3.5 text-sm font-semibold">Recent activity</h2>
          <div className="p-3">
            {activity.length === 0 ? (
              <EmptyIllustration kind="inbox" title="No activity yet" description="Bookings, priority requests and callbacks will appear here." />
            ) : (
              <FreshScope scope="activity" ids={activity.map(activityKey)}>
                <ol className="max-h-[34rem] overflow-y-auto">
                  {activity.map((a) => (
                    <FreshItem key={activityKey(a)} id={activityKey(a)} className="rounded-lg">
                      <ActivityLine row={a} now={now} tz={tz} />
                    </FreshItem>
                  ))}
                </ol>
              </FreshScope>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Sparkline({ values, tone = "routine" }: { values: Array<number | null>; tone?: Tone }) {
  const d = sparkPath(values, 96, 28);
  if (!d) return <div className="h-7 w-24" aria-hidden />;
  return (
    <svg viewBox="0 0 96 28" className={cn("h-7 w-24 overflow-visible", TONE_TEXT[tone])} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeltaLine({ delta, betterWhen = "up" }: { delta: Delta; betterWhen?: "up" | "down" | "none" }) {
  if (!delta) return <span className="text-muted-foreground">No data yesterday</span>;
  const good = betterWhen === "none" || delta.direction === "flat" ? null : delta.direction === betterWhen;
  return (
    <span className={cn("tabular", good === true ? "text-success-ink" : good === false ? "text-safety-ink" : "text-muted-foreground")}>
      {delta.direction === "up" ? "▲ " : delta.direction === "down" ? "▼ " : ""}
      {delta.text}
    </span>
  );
}

function Kpis({ stats, series }: { stats: OverviewStats; series: DailyPoint[] }) {
  const y = series.at(-2) ?? null;
  const pick = (k: keyof Omit<DailyPoint, "day">) => series.map((p) => p[k]);
  const tiles: Array<{ label: string; value: string; note: string; spark: Array<number | null>; tone: Tone; delta: Delta; better: "up" | "down" | "none" }> = [
    { label: "Calls today", value: String(stats.calls), note: `${stats.toolCalls} tool calls`, spark: pick("calls"), tone: "routine", delta: dayDelta(stats.calls, y?.calls ?? null), better: "none" },
    { label: "Bookings", value: String(stats.bookings), note: "Confirmed today", spark: pick("bookings"), tone: "booked", delta: dayDelta(stats.bookings, y?.bookings ?? null), better: "up" },
    {
      label: "Priority requests",
      value: String(stats.priorityRequests),
      note: `${stats.openDispatches} still open`,
      spark: pick("priorityRequests"),
      tone: "emergency",
      delta: dayDelta(stats.priorityRequests, y?.priorityRequests ?? null),
      better: "none",
    },
    { label: "Open callbacks", value: String(stats.openCallbacks), note: "Waiting on the office", spark: [], tone: "callback", delta: null, better: "down" },
    {
      label: "Median response",
      value: formatSeconds(stats.medianResponseMs),
      note: stats.responseCalls ? `p95 ${formatSeconds(stats.p95ResponseMs)} · ${stats.responseCalls} call${stats.responseCalls === 1 ? "" : "s"}` : "Caller stops → Ava starts",
      spark: pick("medianResponseMs"),
      tone: "routine",
      delta: dayDelta(stats.medianResponseMs, y?.medianResponseMs ?? null, "percent"),
      better: "down",
    },
    {
      label: "p95 tool latency",
      value: stats.p95ToolMs === null ? "-" : `${stats.p95ToolMs} ms`,
      note: stats.toolErrors ? `${stats.toolErrors} failed today` : "No failures today",
      spark: pick("p95ToolMs"),
      tone: "routine",
      delta: dayDelta(stats.p95ToolMs, y?.p95ToolMs ?? null, "percent"),
      better: "down",
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="shadow-card space-y-2 rounded-2xl bg-card p-4 ring-1 ring-foreground/8">
          <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
          <dd className="flex items-end justify-between gap-2">
            <span className="tabular text-3xl font-semibold tracking-tight">{t.value}</span>
            {t.spark.length > 0 && <Sparkline values={t.spark} tone={t.tone} />}
          </dd>
          <dd className="space-y-0.5 text-xs">
            <p className="text-muted-foreground">{t.note}</p>
            {t.spark.length > 0 && (
              <p className="present-hide">
                <DeltaLine delta={t.delta} betterWhen={t.better} />
              </p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OutcomeMix({ outcomes }: { outcomes: CallOutcome[] }) {
  const slices = outcomeBreakdown(outcomes);
  return (
    <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8">
      <h2 className="flex items-baseline justify-between border-b px-5 py-3.5 text-sm font-semibold">
        Today&apos;s outcomes
        <span className="tabular text-xs font-normal text-muted-foreground">{outcomes.length} calls</span>
      </h2>
      <div className="space-y-4 p-5">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={slices.filter((s) => s.count).map((s) => `${OUTCOME_LABEL[s.outcome]} ${s.count}`).join(", ") || "No calls today"}>
          {slices
            .filter((s) => s.count > 0)
            .map((s) => (
              <div key={s.outcome} className={cn("h-full first:rounded-l-full last:rounded-r-full", TONE_FILL[OUTCOME_TONE[s.outcome]])} style={{ width: `${s.percent}%` }} />
            ))}
        </div>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {slices.map((s) => (
            <li key={s.outcome} className={cn("flex items-center gap-2", s.count === 0 && "text-muted-foreground/70")}>
              <span className={cn("size-2.5 rounded-sm", TONE_FILL[OUTCOME_TONE[s.outcome]], s.count === 0 && "opacity-40")} aria-hidden />
              {OUTCOME_LABEL[s.outcome]}
              <span className="tabular ml-auto text-muted-foreground">{s.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const activityKey = (a: ActivityRow) => `${a.kind}:${a.refId}`;

const KIND: Record<ActivityKind, { icon: LucideIcon; verb: string; tone: Tone }> = {
  call_ended: { icon: PhoneIncomingIcon, verb: "Call ended", tone: "neutral" },
  booked: { icon: CalendarCheckIcon, verb: "Appointment booked", tone: "booked" },
  dispatch_created: { icon: SirenIcon, verb: "Priority request logged", tone: "emergency" },
  dispatch_acknowledged: { icon: HandIcon, verb: "Priority request acknowledged", tone: "routine" },
  dispatch_resolved: { icon: CheckCheckIcon, verb: "Priority request resolved", tone: "booked" },
  callback_created: { icon: PhoneCallIcon, verb: "Callback requested", tone: "callback" },
  callback_done: { icon: CheckCheckIcon, verb: "Callback done", tone: "booked" },
};

function ActivityLine({ row, now, tz }: { row: ActivityRow; now: Date; tz: string }) {
  const { icon: Icon, verb, tone: kindTone } = KIND[row.kind];
  const tone: Tone = row.kind === "dispatch_created" && row.urgency === "safety_stop" ? "safety" : kindTone;
  const who = row.who?.startsWith("+") ? formatPhone(row.who) : row.who;
  const detail =
    row.kind === "call_ended"
      ? row.detail?.replace(/-/g, " ")
      : row.kind.startsWith("callback")
        ? callbackReasonLabel(row.detail)
        : row.detail;
  const content = (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-2 py-2.5">
      <span className={cn("flex size-7 items-center justify-center rounded-lg", TONE_CHIP[tone])}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{verb}</span>
          {who && <span className="text-muted-foreground">{who}</span>}
          {row.urgency && row.urgency !== "routine" && <UrgencyBadge urgency={row.urgency} />}
          <SeedTag show={row.isDemoSeed} />
        </p>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <time dateTime={row.at.toISOString()} className="pt-0.5 text-xs text-muted-foreground tabular-nums">
        {formatTimestamp(row.at, tz, now)}
      </time>
    </div>
  );
  return row.vapiCallId ? (
    <Link href={`/calls/${encodeURIComponent(row.vapiCallId)}`} className="block rounded-lg transition-colors hover:bg-muted/60">
      {content}
    </Link>
  ) : (
    content
  );
}
