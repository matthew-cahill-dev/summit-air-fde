import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  CalendarCheckIcon,
  CheckCheckIcon,
  HandIcon,
  InboxIcon,
  PhoneCallIcon,
  PhoneIncomingIcon,
  SirenIcon,
  type LucideIcon,
} from "lucide-react";
import { SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyState, PageHeader } from "@/components/console/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { loadOverview } from "@/server/console/data";
import { callbackReasonLabel, formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import type { ActivityKind, ActivityRow, OverviewStats } from "@/server/repositories";

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
  const { stats, activity, now, tz } = await loadOverview();
  return (
    <div className="space-y-6">
      <Kpis stats={stats} />
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <EmptyState icon={InboxIcon} title="No activity yet" description="Bookings, priority requests and callbacks will appear here." />
          ) : (
            <FreshScope scope="activity" ids={activity.map(activityKey)}>
              <ol className="-mx-2">
                {activity.map((a) => (
                  <FreshItem key={activityKey(a)} id={activityKey(a)} className="rounded-lg">
                    <ActivityLine row={a} now={now} tz={tz} />
                  </FreshItem>
                ))}
              </ol>
            </FreshScope>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpis({ stats }: { stats: OverviewStats }) {
  const tiles: Array<{ label: string; value: string; note: string }> = [
    { label: "Calls today", value: String(stats.calls), note: `${stats.toolCalls} tool calls` },
    { label: "Bookings today", value: String(stats.bookings), note: "Confirmed appointments" },
    { label: "Priority requests today", value: String(stats.priorityRequests), note: `${stats.openDispatches} still open` },
    { label: "Open callbacks", value: String(stats.openCallbacks), note: "Waiting on the office" },
    {
      label: "Median response time",
      value: formatSeconds(stats.medianResponseMs),
      note: stats.responseCalls
        ? `p95 ${formatSeconds(stats.p95ResponseMs)} · ${stats.responseCalls} call${stats.responseCalls === 1 ? "" : "s"} today`
        : "Caller stops → Ava starts",
    },
    {
      label: "Tool latency",
      value: stats.avgToolMs === null ? "-" : `${stats.avgToolMs} ms`,
      note: `${stats.p95ToolMs === null ? "" : `p95 ${stats.p95ToolMs} ms · `}${stats.toolErrors ? `${stats.toolErrors} failed today` : "no failures today"}`,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="space-y-1 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
          <dd className="text-2xl font-semibold tracking-tight">{t.value}</dd>
          <dd className="text-xs text-muted-foreground">{t.note}</dd>
        </div>
      ))}
    </dl>
  );
}

const activityKey = (a: ActivityRow) => `${a.kind}:${a.refId}`;

const KIND: Record<ActivityKind, { icon: LucideIcon; verb: string }> = {
  call_ended: { icon: PhoneIncomingIcon, verb: "Call ended" },
  booked: { icon: CalendarCheckIcon, verb: "Appointment booked" },
  dispatch_created: { icon: SirenIcon, verb: "Priority request logged" },
  dispatch_acknowledged: { icon: HandIcon, verb: "Priority request acknowledged" },
  dispatch_resolved: { icon: CheckCheckIcon, verb: "Priority request resolved" },
  callback_created: { icon: PhoneCallIcon, verb: "Callback requested" },
  callback_done: { icon: CheckCheckIcon, verb: "Callback done" },
};

function ActivityLine({ row, now, tz }: { row: ActivityRow; now: Date; tz: string }) {
  const { icon: Icon, verb } = KIND[row.kind];
  const who = row.who?.startsWith("+") ? formatPhone(row.who) : row.who;
  const detail =
    row.kind === "call_ended"
      ? row.detail?.replace(/-/g, " ")
      : row.kind.startsWith("callback")
        ? callbackReasonLabel(row.detail)
        : row.detail;
  const content = (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-2 py-2.5">
      <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
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
