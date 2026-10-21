"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  CalendarSearchIcon,
  CheckCheckIcon,
  ClockIcon,
  FileTextIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MapPinIcon,
  PhoneCallIcon,
  PhoneIcon,
  RotateCcwIcon,
  type LucideIcon,
} from "lucide-react";
import { callExcerptAction, calledBackAction, resolveAction, undoConsoleAction } from "@/app/(console)/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { RESOLUTIONS, STAGE_LABEL, type BoardItem, type BoardStage } from "@/server/console/board";
import { formatPhone } from "@/server/console/format";
import { AutoDetectedBadge, OutcomeBadge, PropertyBadge, SeedTag, URGENCY_RAIL, UrgencyBadge, VulnerableList } from "./badges";
import { FreshItem, FreshScope } from "./live";
import { EmptyIllustration, PhoneLink } from "./page";
import { SlaClock } from "./sla-clock";
import { TONE_FILL } from "./tone";
import { useConsoleAction } from "./use-console-action";

export const STAGE_HELP: Record<BoardStage, string> = {
  new: "Waiting for someone to call the customer back. The callback SLA clock is running.",
  called_back: "Someone reached the customer, so the callback SLA has stopped. Resolve it once it's handled.",
  resolved: "Handled, with an outcome. Kept here so nothing is lost.",
};

const clock = (d: Date | null, tz: string) =>
  d ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(d)) : "";

type Override = BoardStage | "gone";

export function DispatchBoard({ items, now, tz, emptyTitle, emptyText }: { items: BoardItem[]; now: string; tz: string; emptyTitle: string; emptyText: string }) {
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [open, setOpen] = useState<{ item: BoardItem; focusResolve: boolean } | null>(null);
  const key = (i: BoardItem) => `${i.kind}:${i.id}`;
  const set = (i: BoardItem, o: Override | null) =>
    setOverrides((m) => {
      const next = { ...m };
      if (o === null) delete next[key(i)];
      else next[key(i)] = o;
      return next;
    });

  const shown = items.filter((i) => overrides[key(i)] !== "gone");
  if (shown.length === 0) return <EmptyIllustration kind="calm" title={emptyTitle} description={emptyText} />;

  return (
    <>
      <FreshScope scope="board" ids={shown.map(key)}>
        <ul className="space-y-3">
          {shown.map((item) => {
            const stage = (overrides[key(item)] as BoardStage | undefined) ?? item.stage;
            return (
              <FreshItem key={key(item)} id={key(item)} className="animate-rise rounded-2xl">
                <BoardCard
                  item={item}
                  stage={stage}
                  now={now}
                  tz={tz}
                  onOpen={(focusResolve) => setOpen({ item, focusResolve })}
                  onStage={(o) => set(item, o)}
                />
              </FreshItem>
            );
          })}
        </ul>
      </FreshScope>
      <Sheet open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {open && (
            <ItemSheet
              item={open.item}
              stage={(overrides[key(open.item)] as BoardStage | undefined) ?? open.item.stage}
              focusResolve={open.focusResolve}
              tz={tz}
              onStage={(o) => {
                set(open.item, o);
                if (o === "gone") setOpen(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Line({ icon: Icon, children, muted }: { icon: LucideIcon; children: ReactNode; muted?: boolean }) {
  return (
    <p className={cn("flex items-start gap-2", muted && "text-muted-foreground")}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function StageBadge({ stage }: { stage: BoardStage }) {
  return (
    <span
      title={STAGE_HELP[stage]}
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold",
        stage === "new" && "bg-foreground text-background",
        stage === "called_back" && "bg-callback-soft text-callback-ink ring-1 ring-inset ring-callback/30",
        stage === "resolved" && "bg-success-soft text-success-ink ring-1 ring-inset ring-success/30",
      )}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

function CardActions({ item, stage, onOpen, onStage, compact }: { item: BoardItem; stage: BoardStage; onOpen: (resolve: boolean) => void; onStage: (o: Override | null) => void; compact?: boolean }) {
  const { run, pending } = useConsoleAction();
  if (stage === "resolved") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        title="Move it back to the open board"
        onClick={(e) => {
          e.stopPropagation();
          run(() => undoConsoleAction({ op: "unresolve", kind: item.kind, id: item.id }), { optimistic: () => onStage("gone"), rollback: () => onStage(null) });
        }}
      >
        <RotateCcwIcon data-icon="inline-start" />
        Reopen
      </Button>
    );
  }
  return (
    <div className={cn("flex gap-2", compact ? "flex-wrap justify-end" : "")}>
      {stage === "new" && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          title="You reached the customer. Stops the callback SLA clock; resolve it once it's handled."
          onClick={(e) => {
            e.stopPropagation();
            run((by) => calledBackAction(item.kind, item.id, by), { optimistic: () => onStage("called_back"), rollback: () => onStage(null) });
          }}
        >
          <PhoneCallIcon data-icon="inline-start" />
          Called back
        </Button>
      )}
      <Button
        size="sm"
        disabled={pending}
        title="Close it with an outcome (technician dispatched, appointment booked, …)"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(true);
        }}
      >
        <CheckCheckIcon data-icon="inline-start" />
        Resolve…
      </Button>
    </div>
  );
}

function AppointmentLinks({ item }: { item: BoardItem }) {
  if (!item.appointmentId || !item.appointmentAction) return null;
  const base = `/appointments?focus=${item.appointmentId}&callback=${item.id}`;
  return (
    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
      <Link href={base} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand-soft px-2.5 text-xs font-medium text-brand-ink ring-1 ring-inset ring-brand/25 hover:bg-brand-soft/70">
        <CalendarSearchIcon className="size-3.5" aria-hidden />
        Open appointment
      </Link>
      {item.appointmentAction === "reschedule" && (
        <Link href={`${base}&reschedule=1`} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-xs font-medium text-brand-foreground hover:bg-brand/90">
          <CalendarClockIcon className="size-3.5" aria-hidden />
          Reschedule
        </Link>
      )}
    </div>
  );
}

function BoardCard({ item, stage, now, tz, onOpen, onStage }: { item: BoardItem; stage: BoardStage; now: string; tz: string; onOpen: (resolve: boolean) => void; onStage: (o: Override | null) => void }) {
  const phone = formatPhone(item.callerPhone);
  const address = item.address;
  const rail = item.coverageCheck ? TONE_FILL.coverage : item.kind === "callback" && !item.urgency ? TONE_FILL.callback : URGENCY_RAIL[item.urgency ?? "none"];
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`${item.title}: ${item.callerName ?? "caller"}. Open details`}
      onClick={() => onOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(false);
        }
      }}
      className={cn(
        "shadow-card relative flex cursor-pointer overflow-hidden rounded-2xl bg-card text-left text-sm ring-1 ring-foreground/8 transition-[box-shadow,opacity] duration-200 hover:shadow-raised",
        item.overdue && stage === "new" && "ring-safety/40",
        stage !== "new" && "opacity-95",
      )}
    >
      <div className={cn("w-1.5 shrink-0", rail)} aria-hidden />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <StageBadge stage={stage} />
          {(item.urgency || item.kind === "dispatch") && <UrgencyBadge urgency={item.urgency} />}
          {item.coverageCheck && <OutcomeBadge outcome="coverage_check" />}
          <span className="font-semibold">{item.title}</span>
          {item.autoDetected && <AutoDetectedBadge />}
          <PropertyBadge property={item.property} />
          <SeedTag show={item.isDemoSeed} />
          <span className="tabular ml-auto text-xs text-muted-foreground">Logged {clock(item.createdAt, tz)}</span>
        </header>
        <div className="grid gap-x-8 gap-y-4 px-5 py-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_15rem]">
          <div className="min-w-0 space-y-2.5">
            <div>
              <p className="text-base font-semibold tracking-tight">{item.callerName ?? "Name not given"}</p>
              <span onClick={(e) => e.stopPropagation()}>
                <Line icon={PhoneIcon} muted>
                  <PhoneLink e164={item.callerPhone} display={phone} />
                </Line>
              </span>
            </div>
            {address && (
              <div className="space-y-1">
                <Line icon={MapPinIcon}>
                  {[address.line1, address.unit && `Unit ${address.unit}`].filter(Boolean).join(", ") || "Street not given"}
                  {(address.city || address.zip) && <span className="text-muted-foreground"> · {[address.city, address.zip].filter(Boolean).join(" ")}</span>}
                </Line>
                {address.accessNotes && (
                  <Line icon={KeyRoundIcon} muted>
                    {address.accessNotes}
                  </Line>
                )}
              </div>
            )}
            <VulnerableList items={item.vulnerable} />
          </div>
          <div className="min-w-0 space-y-2.5">
            {item.issue && <p className="line-clamp-2 font-medium text-pretty">{item.issue}</p>}
            {item.language && <Line icon={LanguagesIcon} muted>Call back in {item.language}</Line>}
            {item.preferredTime && (
              <Line icon={ClockIcon}>
                <span className="font-medium">Prefers a call {item.preferredTime}</span>
              </Line>
            )}
            {item.reasons.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {item.reasons.slice(0, 3).map((r) => (
                  <li key={r} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                    <span className="line-clamp-2 text-pretty">{r}</span>
                  </li>
                ))}
              </ul>
            )}
            <AppointmentLinks item={item} />
          </div>
          <div className="flex flex-col justify-between gap-4 border-t pt-3 md:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
            {stage === "resolved" ? (
              <div className="space-y-1 text-xs">
                <p className="text-sm font-semibold text-success-ink">{item.resolution ?? "Resolved"}</p>
                <p className="text-muted-foreground">
                  {clock(item.resolvedAt, tz)}
                  {item.resolvedBy && ` · by ${item.resolvedBy}`}
                </p>
                {item.resolutionNote && <p className="line-clamp-2 text-pretty">“{item.resolutionNote}”</p>}
              </div>
            ) : stage === "called_back" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-callback-ink">
                  <PhoneCallIcon className="size-4" aria-hidden />
                  Called back
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.calledBackAt ? clock(item.calledBackAt, tz) : "just now"}
                  {item.calledBackBy && ` · by ${item.calledBackBy}`} · SLA stopped
                </p>
              </div>
            ) : (
              <SlaClock createdAt={new Date(item.createdAt).toISOString()} slaMinutes={item.slaMinutes} acknowledgedAt={null} serverNow={now} />
            )}
            <CardActions item={item} stage={stage} onOpen={onOpen} onStage={onStage} compact />
          </div>
        </div>
      </div>
    </article>
  );
}

function ItemSheet({ item, stage, focusResolve, tz, onStage }: { item: BoardItem; stage: BoardStage; focusResolve: boolean; tz: string; onStage: (o: Override | null) => void }) {
  const [excerpt, setExcerpt] = useState<Array<{ role: "caller" | "ava" | null; text: string }> | null>(null);
  const [resolution, setResolution] = useState<string>("");
  const [note, setNote] = useState("");
  const { run, pending } = useConsoleAction();
  useEffect(() => {
    let live = true;
    if (item.vapiCallId) callExcerptAction(item.vapiCallId).then((x) => live && setExcerpt(x));
    return () => {
      live = false;
    };
  }, [item.vapiCallId]);
  const phone = formatPhone(item.callerPhone);
  return (
    <div className="space-y-6 px-6 pb-8">
      <SheetHeader className="space-y-2 px-0 pt-6 pr-8">
        <div className="flex flex-wrap items-center gap-2">
          <StageBadge stage={stage} />
          {(item.urgency || item.kind === "dispatch") && <UrgencyBadge urgency={item.urgency} />}
          {item.coverageCheck && <OutcomeBadge outcome="coverage_check" />}
          {item.autoDetected && <AutoDetectedBadge />}
        </div>
        <SheetTitle className="text-lg">{item.title}</SheetTitle>
        <SheetDescription>{STAGE_HELP[stage]}</SheetDescription>
      </SheetHeader>

      <section className="space-y-2 text-sm">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Caller</h3>
        <p className="text-base font-semibold">{item.callerName ?? "Name not given"}</p>
        <Line icon={PhoneIcon}>
          <PhoneLink e164={item.callerPhone} display={phone} />
        </Line>
        {item.address && (
          <Line icon={MapPinIcon}>
            {[item.address.line1, item.address.unit && `Unit ${item.address.unit}`, item.address.city, item.address.zip].filter(Boolean).join(", ") || "Address not given"}
          </Line>
        )}
        {item.address?.accessNotes && <Line icon={KeyRoundIcon} muted>{item.address.accessNotes}</Line>}
        <VulnerableList items={item.vulnerable} />
      </section>

      {(item.issue || item.reasons.length > 0) && (
        <section className="space-y-2 text-sm">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Why</h3>
          {item.issue && <p className="font-medium text-pretty">{item.issue}</p>}
          <ul className="space-y-1 text-muted-foreground">
            {item.reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                <span className="text-pretty">{r}</span>
              </li>
            ))}
          </ul>
          <AppointmentLinks item={item} />
        </section>
      )}

      {item.notes && (
        <section className="space-y-2 text-sm">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <FileTextIcon className="size-3.5" aria-hidden /> Technician notes
          </h3>
          <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed whitespace-pre-line">{item.notes}</p>
        </section>
      )}

      {item.vapiCallId && (
        <section className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">From the call</h3>
            <Link href={`/calls/${encodeURIComponent(item.vapiCallId)}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
              Open call <ArrowUpRightIcon className="size-3" aria-hidden />
            </Link>
          </div>
          {excerpt === null ? (
            <p className="text-xs text-muted-foreground">Loading the conversation…</p>
          ) : excerpt.length === 0 ? (
            <p className="text-xs text-muted-foreground">No transcript yet.</p>
          ) : (
            <ol className="space-y-1.5">
              {excerpt.map((m, i) => (
                <li key={i} className={cn("flex", m.role === "ava" ? "justify-start" : "justify-end")}>
                  <p className={cn("max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed", m.role === "ava" ? "rounded-tl-md bg-muted" : "rounded-tr-md bg-brand text-brand-foreground")}>{m.text}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section className="space-y-3 border-t pt-5">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{stage === "resolved" ? "Resolution" : "Next step"}</h3>
        {stage === "resolved" ? (
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-success-ink">{item.resolution ?? "Resolved"}</p>
            <p className="text-xs text-muted-foreground">
              {clock(item.resolvedAt, tz)}
              {item.resolvedBy && ` · by ${item.resolvedBy}`}
            </p>
            {item.resolutionNote && <p className="text-pretty">“{item.resolutionNote}”</p>}
            <div className="pt-2">
              <CardActions item={item} stage={stage} onOpen={() => {}} onStage={onStage} />
            </div>
          </div>
        ) : (
          <>
            {stage === "new" && (
              <CardActions item={item} stage={stage} onOpen={() => document.getElementById("resolution-0")?.focus()} onStage={onStage} />
            )}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Resolve with an outcome</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {RESOLUTIONS.map((r, i) => (
                  <button
                    key={r}
                    id={`resolution-${i}`}
                    type="button"
                    role="radio"
                    aria-checked={resolution === r}
                    autoFocus={focusResolve && i === 0}
                    onClick={() => setResolution(r)}
                    className={cn(
                      "h-8 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors",
                      resolution === r ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Note (optional)
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="e.g. Tech Luis on site 4:30 PM"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <Button
                disabled={!resolution || pending}
                onClick={() =>
                  run((by) => resolveAction(item.kind, item.id, resolution, note, by), { optimistic: () => onStage("gone"), rollback: () => onStage(null) })
                }
              >
                <CheckCheckIcon data-icon="inline-start" />
                Resolve{resolution ? ` · ${resolution}` : ""}
              </Button>
            </fieldset>
          </>
        )}
      </section>
    </div>
  );
}
