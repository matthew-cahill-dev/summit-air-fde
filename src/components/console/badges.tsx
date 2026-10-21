import { HeartPulseIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { URGENCY_LABEL, vulnerableLabel } from "@/server/console/format";
import { OUTCOME_LABEL, type CallOutcome, type CallStatus } from "@/server/console/outcome";
import type { Urgency } from "@/server/repositories";

const URGENCY_STYLE: Record<Urgency, string> = {
  safety_stop: "bg-safety text-white dark:text-white",
  emergency: "bg-emergency-soft text-emergency-ink ring-1 ring-inset ring-emergency/30",
  urgent: "bg-urgent-soft text-urgent-ink ring-1 ring-inset ring-urgent/40",
  routine: "bg-secondary text-secondary-foreground",
};

export function UrgencyBadge({ urgency, className }: { urgency: Urgency | null; className?: string }) {
  if (!urgency) {
    return (
      <Badge variant="outline" className={cn("text-muted-foreground", className)}>
        Untriaged
      </Badge>
    );
  }
  return <Badge className={cn(URGENCY_STYLE[urgency], className)}>{URGENCY_LABEL[urgency]}</Badge>;
}

/** Left rail color for board cards and timeline accents. */
export const URGENCY_RAIL: Record<Urgency | "none", string> = {
  safety_stop: "bg-safety",
  emergency: "bg-emergency",
  urgent: "bg-urgent",
  routine: "bg-border",
  none: "bg-border",
};

const OUTCOME_STYLE: Record<CallOutcome, string> = {
  safety_stop: "bg-safety-soft text-safety-ink ring-1 ring-inset ring-safety/25",
  booked: "bg-success-soft text-success-ink ring-1 ring-inset ring-success/25",
  priority_dispatch: "bg-emergency-soft text-emergency-ink ring-1 ring-inset ring-emergency/30",
  callback: "bg-secondary text-secondary-foreground",
  not_serviceable: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
  incomplete: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
};

export function OutcomeBadge({ outcome, status }: { outcome: CallOutcome; status?: CallStatus }) {
  if (status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="outline" className="gap-1.5">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-70 motion-reduce:hidden" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success" />
          </span>
          In progress
        </Badge>
        {outcome !== "incomplete" && <Badge className={OUTCOME_STYLE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge className={OUTCOME_STYLE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>
      {status === "report_missing" && (
        <span className="text-xs text-muted-foreground" title="Tool activity but no end-of-call report from Vapi">
          No report
        </span>
      )}
    </span>
  );
}

/** Residential / Commercial / Multi-unit, from the call's triage. Commercial and multi-unit stand out. */
export function PropertyBadge({ property }: { property: string | null }) {
  if (!property) return null;
  return (
    <Badge variant="outline" className={property === "Residential" ? "text-muted-foreground" : "border-foreground/30 font-semibold"}>
      {property}
    </Badge>
  );
}

export function SeedTag({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <Badge
      variant="outline"
      className="h-4 rounded-sm px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
      title="Fictional demo data from npm run db:seed"
    >
      Seed
    </Badge>
  );
}

export function MemberBadge() {
  return <Badge className="bg-primary/8 text-foreground ring-1 ring-inset ring-foreground/10 dark:bg-primary/12">Member</Badge>;
}

export function VulnerableList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <HeartPulseIcon className="size-3.5 text-safety-ink" aria-hidden />
      <span className="sr-only">Vulnerable occupants:</span>
      {items.map((v) => (
        <Badge key={v} variant="outline" className="border-safety/30 text-safety-ink">
          {vulnerableLabel(v)}
        </Badge>
      ))}
    </div>
  );
}
