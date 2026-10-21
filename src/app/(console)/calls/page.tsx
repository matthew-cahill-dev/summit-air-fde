import type { Metadata } from "next";
import { Suspense } from "react";
import { CallsTable, type CallRowView } from "@/components/console/calls-table";
import { PageHeader, TableSkeleton } from "@/components/console/page";
import { loadCalls } from "@/server/console/data";
import { formatPhone, formatSeconds, formatTimestamp } from "@/server/console/format";
import { todayInZone, zonedTimeToUtc } from "@/server/lib/time";

export const metadata: Metadata = { title: "Calls" };

export default function CallsPage() {
  return (
    <>
      <PageHeader title="Calls" description="Every call the assistant handled, newest first, with what it led to." />
      <Suspense fallback={<TableSkeleton />}>
        <Calls />
      </Suspense>
    </>
  );
}

const mmss = (ms: number | null) => {
  if (ms === null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function Calls() {
  const { calls, now, tz } = await loadCalls();
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
    timeLabel: c.at ? formatTimestamp(c.at, tz, now) : "Unknown",
    phoneLabel: formatPhone(c.callerPhone),
    durationLabel: mmss(c.durationMs),
    responseLabel: c.responseP50Ms === null ? null : formatSeconds(c.responseP50Ms),
  }));
  return <CallsTable rows={rows} now={now.getTime()} todayStart={zonedTimeToUtc(todayInZone(tz, now), 0, 0, tz).getTime()} />;
}
