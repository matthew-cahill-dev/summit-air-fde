import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { OutcomeBadge, SeedTag, UrgencyBadge } from "@/components/console/badges";
import { PageHeader, PhoneLink } from "@/components/console/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { loadCall } from "@/server/console/data";
import { formatDuration, formatPhone, formatTimestamp, toolLabel } from "@/server/console/format";
import { keyArgs } from "@/server/console/outcome";
import type { InvocationRow } from "@/server/repositories";

export const metadata: Metadata = { title: "Call" };

export default function CallPage({ params }: PageProps<"/calls/[id]">) {
  return (
    <>
      <Link
        href="/calls"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
      <Skeleton className="h-14 w-80" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

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
  const invocations = records.invocations;
  const startedAt = call.startedAt ?? call.firstActivityAt;
  const duration = formatDuration(call.startedAt, call.endedAt);
  const phone = formatPhone(summary.callerPhone);

  return (
    <div className="space-y-6">
      <PageHeader
        title={summary.callerName ?? phone ?? "Unknown caller"}
        description={[
          startedAt ? formatTimestamp(startedAt, tz, now) : null,
          duration ? `${duration} long` : null,
          call.endedReason ? `Ended: ${call.endedReason.replace(/-/g, " ")}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <SeedTag show={summary.isDemoSeed} />
          {/* A safety stop's outcome badge already says "Safety stop"; don't show it twice. */}
          {summary.urgency && !(summary.urgency === "safety_stop" && summary.outcome === "safety_stop") && (
            <UrgencyBadge urgency={summary.urgency} />
          )}
          <OutcomeBadge outcome={summary.outcome} status={summary.status} />
        </div>
      </PageHeader>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10 md:grid-cols-4">
        <Fact label="Phone">
          <PhoneLink e164={summary.callerPhone} display={phone} />
        </Fact>
        <Fact label="Issue">{summary.issue ?? "Not captured"}</Fact>
        <Fact label="Tool calls">
          {summary.toolCount}
          {summary.toolErrors > 0 && <span className="text-destructive"> · {summary.toolErrors} failed</span>}
        </Fact>
        <Fact label="Vapi call ID">
          <span className="font-mono text-xs break-all text-muted-foreground">{call.vapiCallId}</span>
        </Fact>
      </dl>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Tool timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {invocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">The assistant made no tool calls on this call.</p>
            ) : (
              <Timeline invocations={invocations} start={invocations[0].createdAt} />
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Triage reasons</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.reasons.length ? (
                <ul className="space-y-1.5 text-sm">
                  {summary.reasons.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
                      {r}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No triage reasons recorded.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-pretty">
                {call.summary ??
                  (summary.status === "in_progress" ? (
                    <span className="text-muted-foreground">The summary arrives when the call ends.</span>
                  ) : (
                    <span className="text-muted-foreground">No summary from Vapi.</span>
                  ))}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent>
          {call.transcript ? (
            <Transcript text={call.transcript} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {summary.status === "in_progress" ? "The transcript arrives when the call ends." : "No transcript from Vapi."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}

function Timeline({ invocations, start }: { invocations: InvocationRow[]; start: Date }) {
  return (
    <ol className="relative space-y-0">
      {invocations.map((inv, i) => {
        const errorCode = typeof inv.result.error_code === "string" ? inv.result.error_code : null;
        const args = keyArgs(inv.args);
        const offset = Math.round((inv.createdAt.getTime() - start.getTime()) / 1000);
        return (
          <li key={inv.id} className="relative grid grid-cols-[3.5rem_1.25rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0">
            <span className="pt-0.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
              +{Math.floor(offset / 60)}:{String(offset % 60).padStart(2, "0")}
            </span>
            <span className="relative flex justify-center">
              {i < invocations.length - 1 && <span className="absolute top-5 bottom-[-1.25rem] w-px bg-border" aria-hidden />}
              {inv.ok ? (
                <CircleCheckIcon className="relative mt-0.5 size-4 text-success" aria-label="ok" />
              ) : (
                <CircleAlertIcon className="relative mt-0.5 size-4 text-destructive" aria-label="error" />
              )}
            </span>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-mono text-sm font-medium">{toolLabel(inv.toolName)}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {inv.latencyMs} ms total
                  {inv.dbMs !== null && <> · {inv.dbMs} ms db</>}
                </span>
              </div>
              {!inv.ok && (
                <p className="text-xs text-destructive">
                  {errorCode ?? "error"}
                  {typeof inv.result.message === "string" && `: ${inv.result.message}`}
                </p>
              )}
              {args.length > 0 && (
                <dl className="flex flex-wrap gap-1.5">
                  {args.map(([k, v]) => (
                    <div key={k} className="flex max-w-full min-w-0 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                      <dt className="shrink-0 text-muted-foreground">{k}</dt>
                      <dd className="ml-1.5 truncate" title={v}>
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Vapi transcripts are "AI: ..." / "User: ..." lines. */
function Transcript({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return (
    <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-2 text-sm leading-relaxed">
      {lines.map((line, i) => {
        const m = /^(AI|User|Assistant|Bot|Customer)\s*:\s*(.*)$/i.exec(line);
        const speaker = m ? (/^(ai|assistant|bot)$/i.test(m[1]) ? "Ava" : "Caller") : null;
        return (
          <p key={i} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
            <span className={cn("text-xs font-medium pt-0.5", speaker === "Ava" ? "text-muted-foreground" : "text-foreground")}>
              {speaker ?? ""}
            </span>
            <span className={cn(speaker === "Ava" && "text-muted-foreground")}>{m ? m[2] : line}</span>
          </p>
        );
      })}
    </div>
  );
}
