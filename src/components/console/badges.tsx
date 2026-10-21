import { HeartPulseIcon, ScanSearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { URGENCY_LABEL, vulnerableLabel } from "@/server/console/format";
import { OUTCOME_LABEL, type CallOutcome, type CallStatus } from "@/server/console/outcome";
import type { Urgency } from "@/server/repositories";
import { OUTCOME_TONE, TONE_BADGE, TONE_FILL, URGENCY_TONE } from "./tone";

const URGENCY_STYLE: Record<Urgency, string> = {
  // A safety stop is the one solid badge: it has to be impossible to miss.
  safety_stop: "bg-safety text-white dark:text-white",
  emergency: TONE_BADGE.emergency,
  urgent: TONE_BADGE.urgent,
  routine: TONE_BADGE.routine,
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
  safety_stop: TONE_FILL[URGENCY_TONE.safety_stop],
  emergency: TONE_FILL[URGENCY_TONE.emergency],
  urgent: TONE_FILL[URGENCY_TONE.urgent],
  routine: TONE_FILL[URGENCY_TONE.routine],
  none: TONE_FILL.neutral,
};

const OUTCOME_STYLE = Object.fromEntries(Object.entries(OUTCOME_TONE).map(([k, t]) => [k, TONE_BADGE[t]])) as Record<CallOutcome, string>;

/** A pulsing green dot: something is happening right now. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-2", className)} aria-hidden>
      <span className="animate-live absolute inline-flex size-full rounded-full bg-success" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <Badge className="gap-1.5 bg-success-soft text-success-ink ring-1 ring-inset ring-success/30">
      <LiveDot className="size-1.5 [&>span]:size-1.5" />
      {label}
    </Badge>
  );
}

export function OutcomeBadge({ outcome, status }: { outcome: CallOutcome; status?: CallStatus }) {
  if (status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <LiveBadge />
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

/** A safety or priority record the system created after the call from the caller's words. */
export function AutoDetectedBadge() {
  return (
    <Badge
      className="gap-1 bg-safety-soft text-safety-ink ring-1 ring-inset ring-safety/30"
      title="Created after the call: the transcript showed safety or medical signs and the call had no record"
    >
      <ScanSearchIcon className="size-3" aria-hidden />
      Auto-detected
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

/** A Vapi simulation, web call or dashboard test: shown only when "Show test runs" is on. */
export function TestTag({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <Badge
      variant="outline"
      className="h-4 rounded-sm border-dashed px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
      title="Test run: a Vapi simulation or web call, not a real phone call. Excluded from every count unless Show test runs is on."
    >
      Test
    </Badge>
  );
}

export function MemberBadge() {
  return <Badge className="bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand/30">Member</Badge>;
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
