"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DEFAULT_FILTER, filterCalls, type CallFilter, type CallRowLite } from "@/server/console/call-filters";
import { OUTCOME_LABEL, type CallOutcome } from "@/server/console/outcome";
import type { Urgency } from "@/server/repositories";
import { LiveDot, OutcomeBadge, SeedTag, TestTag, UrgencyBadge } from "./badges";
import { FreshRow, FreshScope } from "./live";
import { EmptyIllustration } from "./page";
import { OUTCOME_TONE, TONE_FILL } from "./tone";

export type CallRowView = CallRowLite & {
  isDemoSeed: boolean;
  isSimulation: boolean;
  timeLabel: string;
  phoneLabel: string | null;
  durationLabel: string | null;
  responseLabel: string | null;
};

const OUTCOMES: CallOutcome[] = ["safety_stop", "priority_dispatch", "booked", "coverage_check", "callback", "not_serviceable", "incomplete"];
const URGENCIES: Array<{ v: Urgency; label: string }> = [
  { v: "safety_stop", label: "Safety stop" },
  { v: "emergency", label: "Emergency" },
  { v: "urgent", label: "Urgent" },
  { v: "routine", label: "Routine" },
];

function Chip({ active, onClick, children, dot }: { active: boolean; onClick: () => void; children: React.ReactNode; dot?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors duration-150",
        active ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground",
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />}
      {children}
    </button>
  );
}

export function CallsTable({ rows, now, todayStart, initial }: { rows: CallRowView[]; now: number; todayStart: number; initial?: Partial<CallFilter> }) {
  const [filter, setFilter] = useState<CallFilter>({ ...DEFAULT_FILTER, ...initial });
  const shown = useMemo(() => filterCalls(rows, filter, now, todayStart), [rows, filter, now, todayStart]);
  const set = (patch: Partial<CallFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const filtered = filter.outcome !== "all" || filter.urgency !== "all" || filter.range !== "all" || filter.q !== "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={filter.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search caller name or phone"
            aria-label="Search calls by caller name or phone"
            className="h-8 pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Time range">
          {(["all", "today", "7d"] as const).map((r) => (
            <Chip key={r} active={filter.range === r} onClick={() => set({ range: r })}>
              {r === "all" ? "All time" : r === "today" ? "Today" : "7 days"}
            </Chip>
          ))}
        </div>
        {filtered && (
          <button type="button" onClick={() => setFilter(DEFAULT_FILTER)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <XIcon className="size-3.5" aria-hidden /> Clear filters
          </button>
        )}
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {shown.length} of {rows.length} calls
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Outcome">
        <Chip active={filter.outcome === "all"} onClick={() => set({ outcome: "all" })}>
          All outcomes
        </Chip>
        {OUTCOMES.map((o) => (
          <Chip key={o} active={filter.outcome === o} onClick={() => set({ outcome: filter.outcome === o ? "all" : o })} dot={TONE_FILL[OUTCOME_TONE[o]]}>
            {OUTCOME_LABEL[o]}
          </Chip>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        {URGENCIES.map((u) => (
          <Chip key={u.v} active={filter.urgency === u.v} onClick={() => set({ urgency: filter.urgency === u.v ? "all" : u.v })}>
            {u.label}
          </Chip>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyIllustration
          kind="phone"
          title={rows.length === 0 ? "No calls yet" : "No calls match"}
          description={rows.length === 0 ? "Calls appear here as soon as the assistant makes its first tool call." : "Try a different filter or search."}
        />
      ) : (
        <div className="shadow-card overflow-x-auto rounded-2xl bg-card ring-1 ring-foreground/8">
          <FreshScope scope="calls" ids={shown.map((c) => c.vapiCallId)}>
            <Table className="min-w-[60rem]">
              <TableHeader>
                <tr className="border-b bg-muted/40">
                  <TableHead className="w-32 pl-5">Time</TableHead>
                  <TableHead className="w-52">Caller</TableHead>
                  <TableHead className="min-w-56">Issue</TableHead>
                  <TableHead className="w-28">Urgency</TableHead>
                  <TableHead className="w-40">Outcome</TableHead>
                  <TableHead className="present-hide w-16 text-right">Length</TableHead>
                  <TableHead className="w-20 pr-5 text-right">Response</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {shown.map((c) => {
                  const live = c.status === "in_progress";
                  return (
                    <FreshRow
                      key={c.vapiCallId}
                      id={c.vapiCallId}
                      className={cn("group relative border-b transition-colors duration-150 last:border-0 hover:bg-muted/50", live && "bg-success-soft/50")}
                    >
                      <TableCell className="tabular pl-5 align-top text-muted-foreground">
                        {/* The whole row is a link target; the anchor stretches over it. */}
                        <Link href={`/calls/${encodeURIComponent(c.vapiCallId)}`} className="after:absolute after:inset-0">
                          <span className="inline-flex items-center gap-2">
                            {live && <LiveDot />}
                            {c.timeLabel}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.callerName ?? c.phoneLabel ?? "Unknown caller"}</span>
                          <SeedTag show={c.isDemoSeed} />
                          <TestTag show={c.isSimulation} />
                        </div>
                        {c.callerName && c.phoneLabel && <div className="tabular text-xs text-muted-foreground">{c.phoneLabel}</div>}
                      </TableCell>
                      <TableCell className="max-w-0 align-top whitespace-normal">
                        <p className="line-clamp-2 text-pretty">{c.issue ?? <span className="text-muted-foreground">Not captured</span>}</p>
                      </TableCell>
                      <TableCell className="align-top">{c.urgency ? <UrgencyBadge urgency={c.urgency} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell className="align-top">
                        <OutcomeBadge outcome={c.outcome} status={c.status} />
                      </TableCell>
                      <TableCell className="tabular present-hide text-right align-top text-muted-foreground">{c.durationLabel ?? (live ? "live" : "-")}</TableCell>
                      <TableCell className="tabular pr-5 text-right align-top">{c.responseLabel ?? <span className="text-muted-foreground">-</span>}</TableCell>
                    </FreshRow>
                  );
                })}
              </TableBody>
            </Table>
          </FreshScope>
        </div>
      )}
    </div>
  );
}
