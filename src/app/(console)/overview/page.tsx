import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  ArrowRightIcon,
  CalendarCheckIcon,
  CheckCheckIcon,
  CircleCheckBigIcon,
  HandIcon,
  PhoneCallIcon,
  PhoneForwardedIcon,
  PhoneIncomingIcon,
  SirenIcon,
  type LucideIcon,
} from "lucide-react";
import { SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyIllustration, PageHeader } from "@/components/console/page";
import { SlaClock } from "@/components/console/sla-clock";
import { OUTCOME_TONE, TONE_CHIP, TONE_FILL, URGENCY_TONE, type Tone } from "@/components/console/tone";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BoardItem } from "@/server/console/board";
import { outcomeBreakdown } from "@/server/console/charts";
import { loadOverview } from "@/server/console/data";
import { callbackReasonLabel, formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import type { ToolHealth, TodayMetrics } from "@/server/console/metrics";
import { OUTCOME_LABEL, type CallOutcome } from "@/server/console/outcome";
import type { ActivityKind, ActivityRow } from "@/server/repositories";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="What needs a person now, then today so far (America/New_York). Every number links to the records behind it." />
      <Suspense fallback={<OverviewSkeleton />}>
        <Overview />
      </Suspense>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-32 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}

async function Overview() {
  const { metrics, attention, byHour, health, outcomes, activity, now, tz } = await loadOverview();
  return (
    <div className="space-y-6">
      <NeedsAttention items={attention} now={now} tz={tz} />
      <Today m={metrics} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <CallsByHour counts={byHour} hourNow={Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now))} />
        <OutcomeMix outcomes={outcomes} />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
        <CallerExperience m={metrics} />
        <SystemHealth h={health} />
        <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8 xl:row-span-2">
          <h2 className="border-b px-5 py-3.5 text-sm font-semibold">Recent activity</h2>
          <div className="p-3">
            {activity.length === 0 ? (
              <EmptyIllustration kind="inbox" title="No activity yet" description="Bookings, priority requests and callbacks will appear here." />
            ) : (
              <FreshScope scope="activity" ids={activity.map(activityKey)}>
                <ol className="max-h-[30rem] overflow-y-auto">
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

// --- Needs attention now ------------------------------------------------------------------

function NeedsAttention({ items, now, tz }: { items: BoardItem[]; now: Date; tz: string }) {
  return (
    <section className={cn("shadow-card rounded-2xl ring-1", items.length ? "bg-safety-soft/40 ring-safety/30" : "bg-card ring-foreground/8")} aria-labelledby="attention">
      <h2 id="attention" className="flex items-center justify-between gap-3 px-5 pt-3.5 pb-2 text-sm font-semibold">
        <span className="flex items-center gap-2" title="Safety stops and emergencies nobody has called back yet, plus anything past its callback SLA">
          Needs attention now
          {items.length > 0 && <span className="tabular rounded-full bg-safety px-2 text-xs leading-5 text-white">{items.length}</span>}
        </span>
        <Link href="/dispatch" className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
          Dispatch board <ArrowRightIcon className="size-3" aria-hidden />
        </Link>
      </h2>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-4 text-sm text-muted-foreground">
          <CircleCheckBigIcon className="size-4 text-success-ink" aria-hidden />
          <span>
            <span className="font-medium text-foreground">All clear.</span> No safety stops or emergencies waiting, and nothing past its callback SLA.
          </span>
        </p>
      ) : (
        <ul className="grid gap-2 px-3 pb-3 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <Link
                href={`/dispatch?kind=${i.urgency === "safety_stop" ? "safety" : i.kind === "dispatch" ? "priority" : i.coverageCheck ? "coverage" : "callbacks"}`}
                className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-3 rounded-xl bg-card px-3.5 py-3 ring-1 ring-foreground/8 transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {i.urgency ? <UrgencyBadge urgency={i.urgency} /> : <span className={cn("rounded-md px-1.5 text-xs font-medium", TONE_CHIP.callback)}>Callback</span>}
                    <span className="truncate text-sm font-medium">{i.title}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[i.callerName, formatPhone(i.callerPhone), formatTimestamp(i.createdAt, tz, now)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <SlaClock createdAt={i.createdAt.toISOString()} slaMinutes={i.slaMinutes} acknowledgedAt={null} serverNow={now.toISOString()} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Today --------------------------------------------------------------------------------

/** A number, or "—" with a reason when the data can't exist yet. */
function Value({ v, missing, children }: { v: number | null; missing: string; children?: ReactNode }) {
  if (v === null)
    return (
      <span className="cursor-help text-muted-foreground/60" title={missing}>
        —<span className="sr-only">{missing}</span>
      </span>
    );
  return <>{children ?? v}</>;
}

function Today({ m }: { m: TodayMetrics }) {
  const tiles: Array<{ label: string; value: ReactNode; note: string; href?: string; help: string; tone: Tone }> = [
    {
      label: "Calls answered",
      value: m.calls,
      note: "Real calls since midnight",
      href: "/calls?range=today",
      help: "Every call with an end-of-call report or tool activity today. Test runs and seed data are excluded unless turned on.",
      tone: "routine",
    },
    {
      label: "Bookings",
      value: m.bookings,
      note: "Booked today, any visit day",
      href: "/appointments?view=booked_today",
      help: "Appointments booked today (reschedules don't count twice)",
      tone: "booked",
    },
    {
      label: "Priority requests",
      value: m.priorityRequests,
      note: m.safetyStops ? `+ ${m.safetyStops} safety stop${m.safetyStops === 1 ? "" : "s"}` : "No safety stops today",
      href: "/dispatch?kind=priority",
      help: "Emergencies logged for the on-call technician today",
      tone: "emergency",
    },
    {
      label: "Callbacks pending",
      value: m.callbacksPending,
      note: `${m.callbacksRequested} requested today`,
      href: "/dispatch?kind=callbacks",
      help: "Office callbacks not resolved yet (new or called back), from any day",
      tone: "callback",
    },
    {
      label: "Handled without staff",
      value: (
        <Value v={m.handledWithoutStaffPct} missing="No call has finished with a known outcome today">
          {m.handledWithoutStaffPct}%
        </Value>
      ),
      note: "Booked or closed by Ava alone",
      help: "Of today's finished calls, the share that needed no office follow-up: booked, or explained and closed as not serviceable",
      tone: "booked",
    },
  ];
  return (
    <section aria-labelledby="today" className="space-y-3">
      <h2 id="today" className="text-sm font-semibold">
        Today
      </h2>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {tiles.map((t) => {
          const body = (
            <>
              <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground group-hover:text-foreground">
                <span className={cn("size-1.5 rounded-full", TONE_FILL[t.tone])} aria-hidden />
                {t.label}
                {t.href && <ArrowRightIcon className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
              </dt>
              <dd className="tabular text-3xl font-semibold tracking-tight">{t.value}</dd>
              <dd className="text-xs text-muted-foreground">{t.note}</dd>
            </>
          );
          const cls = "shadow-card group block space-y-1.5 rounded-2xl bg-card p-4 ring-1 ring-foreground/8";
          return t.href ? (
            <Link key={t.label} href={t.href} title={t.help} className={cn(cls, "transition-colors hover:bg-muted/40 hover:ring-brand/30")}>
              {body}
            </Link>
          ) : (
            <div key={t.label} title={t.help} className={cls}>
              {body}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

// --- Calls by hour ------------------------------------------------------------------------

function CallsByHour({ counts, hourNow }: { counts: number[]; hourNow: number }) {
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const W = 480;
  const H = 120;
  const slot = W / 24;
  const bar = slot - 2; // 2px surface gap between bars
  const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
  const busiest = counts.indexOf(Math.max(...counts));
  return (
    <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8" aria-labelledby="by-hour">
      <h2 id="by-hour" className="flex items-baseline justify-between border-b px-5 py-3.5 text-sm font-semibold">
        Calls by hour
        <span className="tabular text-xs font-normal text-muted-foreground">
          {total ? `${total} today · busiest ${hourLabel(busiest)}–${hourLabel((busiest + 1) % 24)}` : "No calls yet today"}
        </span>
      </h2>
      <div className="px-5 pt-4 pb-3">
        <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-auto w-full overflow-visible" role="img" aria-label={`Calls per hour today: ${counts.map((c, h) => (c ? `${hourLabel(h)} ${c}` : null)).filter(Boolean).join(", ") || "none"}`}>
          <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} className="stroke-border" strokeWidth={1} />
          {counts.map((c, h) => {
            const bh = c ? Math.max(4, (c / max) * (H - 14)) : 0;
            const x = h * slot + 1;
            return (
              <g key={h} className="group">
                <title>{`${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${c} call${c === 1 ? "" : "s"}`}</title>
                {/* hit target larger than the mark */}
                <rect x={h * slot} y={0} width={slot} height={H} className="fill-transparent group-hover:fill-muted/60" />
                {c > 0 && (
                  <path
                    d={`M${x},${H} V${H - bh + 4} Q${x},${H - bh} ${x + 4},${H - bh} H${x + bar - 4} Q${x + bar},${H - bh} ${x + bar},${H - bh + 4} V${H} Z`}
                    className={cn(h === hourNow ? "fill-brand" : "fill-brand/55")}
                  />
                )}
                {c > 0 && c === max && (
                  <text x={x + bar / 2} y={H - bh - 4} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
                    {c}
                  </text>
                )}
                {h % 3 === 0 && (
                  <text x={h * slot + slot / 2} y={H + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    {hourLabel(h)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
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
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={slices.filter((s) => s.count).map((s) => `${OUTCOME_LABEL[s.outcome]} ${s.count}`).join(", ") || "No calls today"}>
          {slices
            .filter((s) => s.count > 0)
            .map((s) => (
              <div key={s.outcome} title={`${OUTCOME_LABEL[s.outcome]}: ${s.count}`} className={cn("h-full first:rounded-l-full last:rounded-r-full", TONE_FILL[OUTCOME_TONE[s.outcome]])} style={{ width: `${s.percent}%` }} />
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

// --- Caller experience & system health ----------------------------------------------------

function StatList({ title, help, rows }: { title: string; help: string; rows: Array<{ label: string; value: ReactNode; help: string; alert?: boolean }> }) {
  return (
    <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8">
      <h2 className="border-b px-5 py-3.5 text-sm font-semibold" title={help}>
        {title}
      </h2>
      <dl className="divide-y">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4 px-5 py-3" title={r.help}>
            <dt className="text-sm text-muted-foreground">{r.label}</dt>
            <dd className={cn("tabular shrink-0 text-lg font-semibold whitespace-nowrap", r.alert && "text-safety-ink")}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CallerExperience({ m }: { m: TodayMetrics }) {
  return (
    <StatList
      title="Caller experience"
      help="How callers were served today"
      rows={[
        {
          label: "Median response",
          value: (
            <Value v={m.medianResponseMs} missing="No voice call has measured a response time today">
              {formatSeconds(m.medianResponseMs)}
            </Value>
          ),
          help: `From the caller stopping to Ava starting to speak; median across ${m.respondedCalls} call${m.respondedCalls === 1 ? "" : "s"}`,
        },
        { label: "Callbacks requested", value: m.callbacksRequested, help: "Calls that ended with an office callback request today" },
        { label: "Transfers to on-call", value: m.transfers, help: "Live transfers to the on-call technician today" },
      ]}
    />
  );
}

function SystemHealth({ h }: { h: ToolHealth }) {
  return (
    <StatList
      title="System health"
      help="The booking backend Ava calls during conversations, today"
      rows={[
        {
          label: "Tool latency",
          value: (
            <Value v={h.p50Ms} missing="No tool calls today">
              {h.p50Ms} <span className="text-sm font-normal text-muted-foreground">/ {h.p95Ms} ms</span>
            </Value>
          ),
          help: `Median / 95th percentile of our handler's time per tool call, over ${h.calls} tool calls today`,
        },
        { label: "Real errors", value: h.errors, alert: h.errors > 0, help: "Tool calls that failed for a real reason (a crash, an unknown tool). Should be zero." },
        {
          label: "Guardrail refusals",
          value: h.refusals,
          help: "Requests the backend refused on purpose and told Ava what to do next (missing details, look up first, window taken, emergency not bookable…). Working as designed, not failures.",
        },
      ]}
    />
  );
}

// --- Activity -----------------------------------------------------------------------------

const activityKey = (a: ActivityRow) => `${a.kind}:${a.refId}`;

const KIND: Record<ActivityKind, { icon: LucideIcon; verb: string; tone: Tone }> = {
  call_ended: { icon: PhoneIncomingIcon, verb: "Call ended", tone: "neutral" },
  booked: { icon: CalendarCheckIcon, verb: "Appointment booked", tone: "booked" },
  dispatch_created: { icon: SirenIcon, verb: "Priority request logged", tone: "emergency" },
  dispatch_acknowledged: { icon: HandIcon, verb: "Priority request called back", tone: "routine" },
  dispatch_resolved: { icon: CheckCheckIcon, verb: "Priority request resolved", tone: "booked" },
  callback_created: { icon: PhoneCallIcon, verb: "Callback requested", tone: "callback" },
  callback_called_back: { icon: PhoneForwardedIcon, verb: "Customer called back", tone: "routine" },
  callback_done: { icon: CheckCheckIcon, verb: "Callback resolved", tone: "booked" },
};

function ActivityLine({ row, now, tz }: { row: ActivityRow; now: Date; tz: string }) {
  const { icon: Icon, verb, tone: kindTone } = KIND[row.kind];
  const tone: Tone = row.kind === "dispatch_created" && row.urgency ? URGENCY_TONE[row.urgency] : kindTone;
  const who = row.who?.startsWith("+") ? formatPhone(row.who) : row.who;
  const detail =
    row.kind === "call_ended"
      ? row.detail?.replace(/-/g, " ")
      : row.kind === "callback_created"
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
