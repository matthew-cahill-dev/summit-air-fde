"use client";

import { AlarmClockIcon, TimerIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { slaCountdown } from "@/server/console/sla";
import { useNow } from "./live";

/** Live SLA countdown, ticking every second on the client from the server's timestamps. */
export function SlaClock({ createdAt, slaMinutes, acknowledgedAt, serverNow }: { createdAt: string; slaMinutes: number; acknowledgedAt: string | null; serverNow: string }) {
  // The server's clock for SSR and hydration (no layout shift), then a shared one-second tick.
  const now = useNow(Date.parse(serverNow));
  const s = slaCountdown(Date.parse(createdAt), slaMinutes, now, acknowledgedAt ? Date.parse(acknowledgedAt) : null);
  const Icon = s.overdue ? AlarmClockIcon : TimerIcon;
  return (
    <div className="space-y-1.5">
      <p className={cn("tabular flex items-center gap-1.5 text-sm font-semibold whitespace-nowrap", s.overdue ? "text-safety-ink" : "text-foreground")} role="timer" aria-live="off">
        <Icon className="size-4 shrink-0" aria-hidden />
        {s.label}
      </p>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", s.overdue ? "bg-safety" : s.used > 0.75 ? "bg-urgent" : "bg-success")}
          style={{ width: `${Math.round(s.used * 100)}%` }}
        />
      </div>
    </div>
  );
}
