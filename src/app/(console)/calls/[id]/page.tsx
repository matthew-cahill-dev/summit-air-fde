import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  CalendarCheckIcon,
  ClipboardListIcon,
  MapPinnedIcon,
  PhoneCallIcon,
  ShieldCheckIcon,
  SirenIcon,
  SparklesIcon,
  StethoscopeIcon,
  TriangleAlertIcon,
  UserRoundCheckIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { AutoDetectedBadge, LiveBadge, OutcomeBadge, PropertyBadge, SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FastPoll } from "@/components/console/live";
import { PhoneLink } from "@/components/console/page";
import { OUTCOME_TONE, TONE_CHIP, TONE_FILL } from "@/components/console/tone";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { loadCall, loadCallMessages } from "@/server/console/data";
import { formatClock, formatDuration, formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import { buildSteps, interleave, parseTranscript, type CallStep, type StepIcon } from "@/server/console/steps";
import type { TranscriptMessage } from "@/server/repositories";

export const metadata: Metadata = { title: "Call" };

export default function CallPage({ params }: PageProps<"/calls/[id]">) {
  return (
    <>
      <Link
        href="/calls"
        className="present-hide inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden />
        All calls
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <CallDetail params={params} />
      </Suspense>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-32 rounded-2xl" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Skeleton className="h-96 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}

const STEP_ICON: Record<StepIcon, LucideIcon> = {
  user: UserRoundCheckIcon,
  triage: StethoscopeIcon,
  calendar: CalendarCheckIcon,
  siren: SirenIcon,
  phone: PhoneCallIcon,
  map: MapPinnedIcon,
  shield: ShieldCheckIcon,
  alert: TriangleAlertIcon,
  transfer: ArrowRightLeftIcon,
  tool: WrenchIcon,
};

async function CallDetail({ params }: { params: PageProps<"/calls/[id]">["params"] }) {
  const { id } = await params;
  let vapiCallId = id;
  try {
    vapiCallId = decodeURIComponent(id);
  } catch {
    // Already decoded, or malformed: look it up as given.
  }
  const data = await loadCall(vapiCallId);
  if (!data) notFound();
  const { call, records, summary, now, tz } = data;
  const messages = await loadCallMessages(vapiCallId);
  const steps = buildSteps(records.invocations);
  const live = summary.status === "in_progress";
  const autoDetected = records.dispatches.filter((d) => d.intake?.auto_detected === true);
  const startedAt = call.startedAt ?? call.firstActivityAt;
  const duration = formatDuration(call.startedAt, call.endedAt);
  const phone = formatPhone(summary.callerPhone);

  return (
    <div className="space-y-6">
      {/* Poll every 2 s only while the call is live, so steps appear as Ava works. */}
      {live && <FastPoll intervalMs={2000} />}

      <section className="shadow-card relative overflow-hidden rounded-2xl bg-card p-6 ring-1 ring-foreground/8">
        <div className={cn("absolute inset-x-0 top-0 h-1", live && summary.outcome === "incomplete" ? TONE_FILL.booked : TONE_FILL[OUTCOME_TONE[summary.outcome]])} aria-hidden />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {live && <LiveBadge label="Live call" />}
              {!(live && summary.outcome === "incomplete") && <OutcomeBadge outcome={summary.outcome} status={live ? undefined : summary.status} />}
              {summary.urgency && !(summary.urgency === "safety_stop" && summary.outcome === "safety_stop") && <UrgencyBadge urgency={summary.urgency} />}
              {autoDetected.length > 0 && <AutoDetectedBadge />}
              <PropertyBadge property={summary.property} />
              <SeedTag show={summary.isDemoSeed} />
            </div>
            <h1 className="pt-1 text-2xl font-semibold tracking-tight text-balance">{summary.callerName ?? phone ?? "Unknown caller"}</h1>
            <p className="text-sm text-muted-foreground text-pretty">{summary.issue ?? "Issue not captured yet"}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
            <Meta label="Started">{startedAt ? formatTimestamp(startedAt, tz, now) : "-"}</Meta>
            <Meta label="Duration">{duration ?? (live ? "In progress" : "-")}</Meta>
            <Meta label="Median response">
              {call.responseP50Ms === null ? (
                <span className="text-muted-foreground">{live ? "After the call" : "-"}</span>
              ) : (
                <span title={`Caller stops talking → Ava starts · p95 ${formatSeconds(call.responseP95Ms)}`}>{formatSeconds(call.responseP50Ms)}</span>
              )}
            </Meta>
            <Meta label="Phone">
              <PhoneLink e164={summary.callerPhone} display={phone} />
            </Meta>
          </dl>
        </div>
      </section>

      {autoDetected.map((d) => (
        <section key={d.id} className="flex gap-3 rounded-2xl bg-safety-soft p-4 text-sm ring-1 ring-safety/30" role="note">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-safety-ink" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold text-safety-ink">
              {d.urgency === "safety_stop" ? "Safety stop" : "Priority dispatch"} created after the call
            </p>
            <p className="text-pretty">
              The caller&apos;s words showed {Array.isArray(d.intake?.detected_signals) ? (d.intake.detected_signals as string[]).join(", ") : "safety signs"}, and the call had
              no safety record. It&apos;s on the dispatch board: call the customer back.
            </p>
          </div>
        </section>
      ))}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <Panel title="What happened" icon={ClipboardListIcon} aside={`${steps.length} step${steps.length === 1 ? "" : "s"}`}>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">{live ? "Waiting for Ava's first step…" : "The assistant made no tool calls on this call."}</p>
          ) : (
            <StepTimeline steps={steps} start={startedAt ?? steps[0].at} live={live} />
          )}
        </Panel>

        <div className="space-y-6">
          <section className="rounded-2xl bg-brand-soft p-5 ring-1 ring-brand/20">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand-ink">
              <SparklesIcon className="size-4" aria-hidden />
              Call summary
            </h2>
            <p className="text-[15px] leading-relaxed text-pretty">
              {call.summary ?? <span className="text-muted-foreground">{live ? "The summary arrives when the call ends." : "No summary from Vapi."}</span>}
            </p>
          </section>
          <Panel title="Triage reasons" icon={StethoscopeIcon}>
            {summary.reasons.length ? (
              <ul className="space-y-2 text-sm">
                {summary.reasons.map((r) => (
                  <li key={r} className="flex gap-2.5">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No triage on this call.</p>
            )}
          </Panel>
          <p className="present-hide px-1 font-mono text-[11px] break-all text-muted-foreground">Vapi call {call.vapiCallId}</p>
        </div>
      </div>

      <Panel title="Conversation" icon={PhoneCallIcon} aside={messages.length ? `${messages.length} lines` : undefined}>
        <Conversation messages={messages} steps={steps} transcript={call.transcript} live={live} tz={tz} />
      </Panel>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{children}</dd>
    </div>
  );
}

function Panel({ title, icon: Icon, aside, children }: { title: string; icon: LucideIcon; aside?: string; children: ReactNode }) {
  return (
    <section className="shadow-card rounded-2xl bg-card ring-1 ring-foreground/8">
      <header className="flex items-center gap-2 border-b px-5 py-3.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="tabular ml-auto text-xs text-muted-foreground">{aside}</span>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function offset(at: Date, start: Date) {
  const s = Math.max(0, Math.round((at.getTime() - start.getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function StepTimeline({ steps, start, live }: { steps: CallStep[]; start: Date; live: boolean }) {
  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const Icon = STEP_ICON[step.icon];
        const last = i === steps.length - 1;
        return (
          <li key={step.id} className="animate-rise relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 pb-6 last:pb-0">
            {!last && <span className="absolute top-10 bottom-1 left-[1.125rem] w-px -translate-x-1/2 bg-border" aria-hidden />}
            <span className={cn("relative flex size-9 items-center justify-center rounded-xl", TONE_CHIP[step.tone])}>
              <Icon className="size-4" aria-hidden />
              {live && last && <span className="animate-live absolute inset-0 rounded-xl ring-2 ring-success/60" aria-hidden />}
            </span>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-medium text-pretty">{step.title}</p>
                <span className="tabular shrink-0 font-mono text-xs text-muted-foreground">+{offset(step.at, start)}</span>
              </div>
              {step.detail && <p className="text-sm text-muted-foreground text-pretty">{step.detail}</p>}
              <div className="flex flex-wrap items-center gap-1.5">
                {step.chips.map(([k, v]) => (
                  <span key={k} className="inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                    <span className="shrink-0 text-muted-foreground">{k}</span>
                    <span className="truncate" title={v}>
                      {v}
                    </span>
                  </span>
                ))}
                <span
                  className="tabular present-hide inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
                  title="Our handler's total time, and the part spent in the database"
                >
                  {step.latencyMs} ms{step.dbMs !== null && ` · db ${step.dbMs}`}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Conversation({
  messages,
  steps,
  transcript,
  live,
  tz,
}: {
  messages: TranscriptMessage[];
  steps: CallStep[];
  transcript: string | null;
  live: boolean;
  tz: string;
}) {
  if (messages.length > 0) {
    return (
      <ol className="max-h-[44rem] space-y-1.5 overflow-y-auto pr-1">
        {interleave(messages, steps).map((item, i, all) =>
          item.kind === "message" ? (
            <Bubble
              key={`m${i}`}
              role={item.message.role}
              text={item.message.text}
              time={formatClock(item.message.at, tz)}
              showLabel={!sameSpeaker(all[i - 1], item.message.role)}
            />
          ) : (
            <li key={item.step.id} className="flex justify-center py-1">
              <span className={cn("inline-flex max-w-[90%] items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium", TONE_CHIP[item.step.tone])}>
                {(() => {
                  const Icon = STEP_ICON[item.step.icon];
                  return <Icon className="size-3.5 shrink-0" aria-hidden />;
                })()}
                <span className="truncate">{item.step.title}</span>
              </span>
            </li>
          ),
        )}
      </ol>
    );
  }
  if (transcript) {
    return (
      <ol className="max-h-[44rem] space-y-1.5 overflow-y-auto pr-1">
        {parseTranscript(transcript).map((line, i, all) => (
          <Bubble key={i} role={line.role} text={line.text} showLabel={i === 0 || all[i - 1].role !== line.role} />
        ))}
      </ol>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {live ? "The transcript arrives when the call ends. Ava's steps appear above as they happen." : "No transcript from Vapi."}
    </p>
  );
}

const sameSpeaker = (prev: ReturnType<typeof interleave>[number] | undefined, role: "caller" | "ava") =>
  prev?.kind === "message" && prev.message.role === role;

function Bubble({ role, text, time, showLabel = true }: { role: "caller" | "ava" | null; text: string; time?: string; showLabel?: boolean }) {
  const ava = role === "ava";
  return (
    <li className={cn("flex", ava ? "justify-start" : "justify-end", showLabel && "pt-2")}>
      <div className={cn("max-w-[78%] space-y-1", !ava && "items-end text-right")}>
        {showLabel && (
          <p className="text-[11px] font-medium text-muted-foreground">
            {ava ? "Ava" : role === "caller" ? "Caller" : ""}
            {time && <span className="tabular font-normal"> · {time}</span>}
          </p>
        )}
        <p
          className={cn(
            "rounded-2xl px-3.5 py-2 text-left text-sm leading-relaxed text-pretty",
            ava ? "rounded-tl-md bg-muted" : "rounded-tr-md bg-brand text-brand-foreground",
          )}
        >
          {text}
        </p>
      </div>
    </li>
  );
}
