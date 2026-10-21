import type { Metadata } from "next";
import { Suspense } from "react";
import { CallsTable, type CallRowView } from "@/components/console/calls-table";
import { PageHeader, TableSkeleton } from "@/components/console/page";
import { loadCalls } from "@/server/console/data";
import { formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import type { CallFilter } from "@/server/console/call-filters";
import { OUTCOME_LABEL, type CallOutcome } from "@/server/console/outcome";

export const metadata: Metadata = { title: "Calls" };

export default function CallsPage({ searchParams }: PageProps<"/calls">) {
  return (
    <>
      <PageHeader title="Calls" description="Every call the assistant handled, newest first, with what it led to." />
      <Suspense fallback={<TableSkeleton />}>
        <Calls searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const mmss = (ms: number | null) => {
  if (ms === null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function Calls({ searchParams }: { searchParams: PageProps<"/calls">["searchParams"] }) {
  // Deep links from Overview KPIs, e.g. /calls?range=today or /calls?outcome=booked.
  const sp = await searchParams;
  const initial: Partial<CallFilter> = {};
  if (sp.range === "today" || sp.range === "7d") initial.range = sp.range;
  if (typeof sp.outcome === "string" && sp.outcome in OUTCOME_LABEL) initial.outcome = sp.outcome as CallOutcome;
  const { calls, now, tz, todayStart } = await loadCalls();
  const rows: CallRowView[] = calls.map((c) => ({
    vapiCallId: c.vapiCallId,
    at: c.at ? c.at.toISOString() : null,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    issue: c.issue,
    urgency: c.urgency,
    outcome: c.outcome,
    status: c.status,
    isDemoSeed: c.isDemoSeed,
    isSimulation: c.isSimulation,
    timeLabel: c.at ? formatTimestamp(c.at, tz, now) : "Unknown",
    phoneLabel: formatPhone(c.callerPhone),
    durationLabel: mmss(c.durationMs),
    responseLabel: c.responseP50Ms === null ? null : formatSeconds(c.responseP50Ms),
  }));
  // The same local-midnight boundary the sidebar and Overview count "today" from (metrics.todayWindow).
  return <CallsTable key={`${initial.range ?? ""}:${initial.outcome ?? ""}`} rows={rows} now={now.getTime()} todayStart={todayStart.getTime()} initial={initial} />;
}
