import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PhoneOffIcon } from "lucide-react";
import { OutcomeBadge, SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshRow, FreshScope } from "@/components/console/live";
import { EmptyState, PageHeader, TableSkeleton } from "@/components/console/page";
import { Table, TableBody, TableCell, TableHead, TableHeader } from "@/components/ui/table";
import { loadCalls } from "@/server/console/data";
import { formatPhone, formatTimestamp } from "@/server/console/format";

export const metadata: Metadata = { title: "Calls" };

export default function CallsPage() {
  return (
    <>
      <PageHeader title="Calls" description="Every call the assistant handled, newest first, with what it led to." />
      <Suspense fallback={<TableSkeleton />}>
        <CallsTable />
      </Suspense>
    </>
  );
}

async function CallsTable() {
  const { calls, now, tz } = await loadCalls();
  if (calls.length === 0) {
    return (
      <EmptyState
        icon={PhoneOffIcon}
        title="No calls yet"
        description="Calls appear here as soon as the assistant makes its first tool call."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <FreshScope scope="calls" ids={calls.map((c) => c.vapiCallId)}>
        <Table>
          <TableHeader>
            <tr className="border-b">
              <TableHead className="w-36 pl-4">Time</TableHead>
              <TableHead>Caller</TableHead>
              <TableHead>Issue</TableHead>
              <TableHead className="w-28">Urgency</TableHead>
              <TableHead className="w-56 pr-4">Outcome</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {calls.map((c) => {
              const href = `/calls/${encodeURIComponent(c.vapiCallId)}`;
              return (
                <FreshRow
                  key={c.vapiCallId}
                  id={c.vapiCallId}
                  className="group relative border-b transition-colors last:border-0 hover:bg-muted/50"
                >
                  <TableCell className="pl-4 align-top text-muted-foreground tabular-nums">
                    {/* The whole row is a link target; the anchor stretches over it. */}
                    <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
                      {c.at ? formatTimestamp(c.at, tz, now) : "Unknown"}
                    </Link>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.callerName ?? formatPhone(c.callerPhone) ?? "Unknown caller"}</span>
                      <SeedTag show={c.isDemoSeed} />
                    </div>
                    {c.callerName && c.callerPhone && (
                      <div className="text-xs text-muted-foreground tabular-nums">{formatPhone(c.callerPhone)}</div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <p className="line-clamp-2 text-pretty">{c.issue ?? <span className="text-muted-foreground">Not captured</span>}</p>
                  </TableCell>
                  <TableCell className="align-top">
                    {c.urgency ? <UrgencyBadge urgency={c.urgency} /> : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="pr-4 align-top">
                    <OutcomeBadge outcome={c.outcome} status={c.status} />
                  </TableCell>
                </FreshRow>
              );
            })}
          </TableBody>
        </Table>
      </FreshScope>
    </div>
  );
}
