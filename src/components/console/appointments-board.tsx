"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  KeyRoundIcon,
  MapPinIcon,
  PhoneIcon,
  UserXIcon,
  XIcon,
} from "lucide-react";
import { cancelAppointmentAction, closeAppointmentAction, rescheduleAppointmentAction, rescheduleOptionsAction, resolveAction } from "@/app/(console)/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPhone, formatWindow, serviceLabel } from "@/server/console/format";
import type { AppointmentRow, AppointmentStage } from "@/server/repositories";
import type { WindowOption } from "@/server/services/appointment-lifecycle";
import { MemberBadge, SeedTag, UrgencyBadge } from "./badges";
import { FreshItem } from "./live";
import { PhoneLink } from "./page";
import { TONE_FILL, URGENCY_TONE } from "./tone";
import { useConsoleAction } from "./use-console-action";

export const APPOINTMENT_STAGE: Record<AppointmentStage, { label: string; help: string; className: string }> = {
  scheduled: { label: "Scheduled", help: "Booked and on the schedule.", className: "bg-callback-soft text-callback-ink ring-callback/30" },
  completed: { label: "Completed", help: "The technician finished the visit.", className: "bg-success-soft text-success-ink ring-success/30" },
  no_show: { label: "No-show", help: "Nobody was home to let the technician in.", className: "bg-urgent-soft text-urgent-ink ring-urgent/40" },
  cancelled: { label: "Cancelled", help: "Cancelled; the window's seat was freed for someone else.", className: "bg-muted text-muted-foreground ring-border" },
};

export function StageChip({ stage }: { stage: AppointmentStage }) {
  const s = APPOINTMENT_STAGE[stage];
  return (
    <span title={s.help} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold ring-1 ring-inset", s.className)}>
      {s.label}
    </span>
  );
}

type Panel = "none" | "complete" | "reschedule";

export function AppointmentCard({
  a,
  tz,
  focus,
  openReschedule,
  callbackId,
}: {
  a: AppointmentRow;
  tz: string;
  focus: boolean;
  openReschedule: boolean;
  callbackId: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<Panel>(focus && openReschedule ? "reschedule" : "none");
  const [stage, setStage] = useState<AppointmentStage | null>(null);
  const [note, setNote] = useState("");
  const [options, setOptions] = useState<WindowOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { run, pending } = useConsoleAction();
  const current = stage ?? a.stage;

  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);

  useEffect(() => {
    if (panel !== "reschedule" || options !== null) return;
    let live = true;
    rescheduleOptionsAction(a.id).then((r) => {
      if (!live) return;
      if (r.ok) setOptions(r.options);
      else setOptionsError(r.error);
    });
    return () => {
      live = false;
    };
  }, [panel, options, a.id]);

  return (
    <article
      ref={ref}
      id={`appt-${a.id}`}
      className={cn(
        "shadow-card relative overflow-hidden rounded-2xl bg-card text-sm ring-1 ring-foreground/8 transition-shadow",
        focus && "outline-2 outline-offset-2 outline-brand",
        current !== "scheduled" && "opacity-90",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", current === "cancelled" ? "bg-muted-foreground/30" : TONE_FILL[URGENCY_TONE[a.urgency]])} aria-hidden />
      <div className="grid gap-x-6 gap-y-3 p-4 pl-5 md:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-1.5">
          <p className={cn("tabular inline-flex rounded-lg bg-muted px-2.5 py-1 font-semibold", current === "cancelled" && "line-through decoration-muted-foreground/60")}>
            {formatWindow(new Date(a.startsAt), new Date(a.endsAt), tz)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <StageChip stage={current} />
            <span className="text-xs text-muted-foreground">{a.county}</span>
          </div>
          {a.arrivalPreference && (
            <p className="flex items-center gap-1 text-xs font-medium text-brand-ink" title="The caller's preference inside the window; not promised">
              <ClockIcon className="size-3" aria-hidden />
              Prefers {a.arrivalPreference}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{a.customerName}</span>
            {a.isMember && <MemberBadge />}
            <SeedTag show={a.isDemoSeed} />
          </div>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <PhoneIcon className="size-3.5" aria-hidden />
            <PhoneLink e164={a.customerPhone} display={formatPhone(a.customerPhone)} />
          </p>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">{serviceLabel(a.serviceType)}</span>
            <UrgencyBadge urgency={a.urgency} />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="flex items-start gap-1.5">
            <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              {a.line1}
              {a.unit && `, Unit ${a.unit}`}
              <span className="text-muted-foreground">
                {" "}
                · {a.city} {a.zip}
              </span>
            </span>
          </p>
          {a.accessNotes && (
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="text-pretty">{a.accessNotes}</span>
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-2 md:col-span-3 xl:col-span-1">
          {a.issueSummary && <p className="font-medium text-pretty">{a.issueSummary}</p>}
          {a.technicianNotes && (
            <details className="group rounded-lg bg-muted/60 px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden">
                <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                Technician notes
                <span className="ml-auto text-muted-foreground group-open:hidden">Show</span>
                <span className="ml-auto hidden text-muted-foreground group-open:inline">Hide</span>
              </summary>
              <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">{a.technicianNotes}</p>
            </details>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {a.vapiCallId && (
              <Link href={`/calls/${encodeURIComponent(a.vapiCallId)}`} className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline">
                Originating call <ArrowUpRightIcon className="size-3" aria-hidden />
              </Link>
            )}
            {a.rescheduledFrom && <span className="text-muted-foreground">Rescheduled from an earlier window</span>}
            {a.rescheduledTo && (
              <Link href={`/appointments?focus=${a.rescheduledTo}`} className="font-medium text-brand-ink hover:underline">
                Rescheduled → new window
              </Link>
            )}
            {current === "completed" || current === "no_show" ? (
              <span className="text-muted-foreground">
                {a.completionNote && `“${a.completionNote}”`}
                {a.statusBy && ` · by ${a.statusBy}`}
              </span>
            ) : current === "cancelled" && a.statusBy ? (
              <span className="text-muted-foreground">by {a.statusBy}</span>
            ) : null}
          </div>
        </div>
      </div>

      {current === "scheduled" && (
        <div className="border-t bg-muted/20 px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={panel === "complete" ? "secondary" : "outline"} disabled={pending} onClick={() => setPanel(panel === "complete" ? "none" : "complete")} title="The technician finished the visit">
              <CheckIcon data-icon="inline-start" />
              Completed…
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title="Nobody was home to let the technician in"
              onClick={() => run((by) => closeAppointmentAction(a.id, "no_show", "", by), { optimistic: () => setStage("no_show"), rollback: () => setStage(null) })}
            >
              <UserXIcon data-icon="inline-start" />
              No-show
            </Button>
            <Button size="sm" variant={panel === "reschedule" ? "secondary" : "outline"} disabled={pending} onClick={() => setPanel(panel === "reschedule" ? "none" : "reschedule")} title="Pick a new window from real availability">
              <CalendarClockIcon data-icon="inline-start" />
              Reschedule…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              className="text-muted-foreground hover:text-destructive"
              title="Cancel the visit. Its seat in the window is freed at once."
              onClick={() => run((by) => cancelAppointmentAction(a.id, by), { optimistic: () => setStage("cancelled"), rollback: () => setStage(null) })}
            >
              <XIcon data-icon="inline-start" />
              Cancel
            </Button>
          </div>

          {panel === "complete" && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run((by) => closeAppointmentAction(a.id, "completed", note, by), {
                  optimistic: () => {
                    setStage("completed");
                    setPanel("none");
                  },
                  rollback: () => setStage(null),
                });
              }}
            >
              <label className="min-w-64 flex-1 space-y-1 text-xs text-muted-foreground">
                What was done (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Replaced capacitor, system cooling" className="h-8 w-full rounded-md border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </label>
              <Button size="sm" type="submit" disabled={pending}>
                Mark completed
              </Button>
            </form>
          )}

          {panel === "reschedule" && (
            <div className="mt-3 space-y-2" aria-live="polite">
              <p className="text-xs text-muted-foreground">Open windows in {a.county}, from live availability (the same as on a call). The old window is freed when you confirm.</p>
              {optionsError ? (
                <p className="text-xs text-destructive">{optionsError}</p>
              ) : options === null ? (
                <p className="text-xs text-muted-foreground">Checking availability…</p>
              ) : options.length === 0 ? (
                <p className="text-xs text-muted-foreground">No open windows in the next two weeks. Call the customer to arrange one.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="New window">
                  {options.map((o) => (
                    <button
                      key={o.slotId}
                      type="button"
                      role="radio"
                      aria-checked={picked === o.slotId}
                      onClick={() => setPicked(o.slotId)}
                      className={cn("h-8 rounded-full px-3 text-xs font-medium ring-1 ring-inset", picked === o.slotId ? "bg-brand text-brand-foreground ring-brand" : "bg-card text-foreground ring-border hover:ring-brand/50")}
                    >
                      {o.label.replace(/^(today|tomorrow), /i, (m) => m.charAt(0).toUpperCase() + m.slice(1))}
                    </button>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                disabled={!picked || pending}
                onClick={() =>
                  run((by) => rescheduleAppointmentAction(a.id, picked!, by), {
                    optimistic: () => setPanel("none"),
                    after: () => {
                      if (callbackId) {
                        toast("Resolve the callback too?", {
                          description: "Mark the customer's reschedule request resolved as “Appointment booked”.",
                          duration: 10000,
                          action: {
                            label: "Resolve",
                            onClick: () => run((by2) => resolveAction("callback", callbackId, "Appointment booked", "Rescheduled from the console", by2)),
                          },
                        });
                      }
                    },
                  })
                }
              >
                Confirm new window
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function AppointmentItem(props: Parameters<typeof AppointmentCard>[0]) {
  return (
    <FreshItem id={props.a.id} className="rounded-2xl">
      <AppointmentCard {...props} />
    </FreshItem>
  );
}
