import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowUpRightIcon, ClockIcon, FileTextIcon, KeyRoundIcon, MapPinIcon, PhoneIcon } from "lucide-react";
import { MemberBadge, SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshItem, FreshScope } from "@/components/console/live";
import { EmptyIllustration, ListSkeleton, PageHeader, PhoneLink } from "@/components/console/page";
import { TONE_FILL, URGENCY_TONE } from "@/components/console/tone";
import { cn } from "@/lib/utils";
import { loadAppointments } from "@/server/console/data";
import { formatDayHeading, formatPhone, formatWindow, serviceLabel } from "@/server/console/format";
import type { UpcomingAppointmentRow } from "@/server/repositories";

export const metadata: Metadata = { title: "Appointments" };

export default function AppointmentsPage() {
  return (
    <>
      <PageHeader title="Appointments" description="Upcoming confirmed arrival windows, by day." />
      <Suspense fallback={<ListSkeleton rows={4} height="h-28" />}>
        <Schedule />
      </Suspense>
    </>
  );
}

async function Schedule() {
  const { days, total, now, tz } = await loadAppointments();
  if (days.length === 0) {
    return (
      <EmptyIllustration kind="calendar" title="No upcoming appointments" description="Bookings made on calls show up here with their arrival window and technician notes." />
    );
  }
  return (
    <FreshScope scope="appointments" ids={days.flatMap((d) => d.items.map((a) => a.id))}>
      <p className="tabular -mt-2 text-sm text-muted-foreground">
        {total} upcoming across {days.length} day{days.length === 1 ? "" : "s"}
      </p>
      <div className="space-y-8">
        {days.map((day) => {
          const heading = formatDayHeading(day.first, tz, now);
          const [lead, rest] = heading.includes(" · ") ? heading.split(" · ") : [null, heading];
          return (
            <section key={day.key} aria-labelledby={`day-${day.key}`} className="space-y-3">
              <h2 id={`day-${day.key}`} className="flex items-center gap-2.5 text-sm font-semibold">
                {lead && <span className={cn("rounded-full px-2.5 py-0.5 text-xs", lead === "Today" ? "bg-brand text-brand-foreground" : "bg-brand-soft text-brand-ink")}>{lead}</span>}
                {rest}
                <span className="tabular font-normal text-muted-foreground">
                  {day.items.length} appointment{day.items.length === 1 ? "" : "s"}
                </span>
              </h2>
              <ul className="space-y-2.5">
                {day.items.map((a) => (
                  <FreshItem key={a.id} id={a.id} className="rounded-2xl">
                    <AppointmentCard a={a} tz={tz} />
                  </FreshItem>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </FreshScope>
  );
}

function AppointmentCard({ a, tz }: { a: UpcomingAppointmentRow; tz: string }) {
  return (
    <article className="shadow-card relative grid gap-x-6 gap-y-3 overflow-hidden rounded-2xl bg-card p-4 pl-5 text-sm ring-1 ring-foreground/8 md:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
      <span className={cn("absolute inset-y-0 left-0 w-1", TONE_FILL[URGENCY_TONE[a.urgency]])} aria-hidden />
      <div className="space-y-1.5">
        <p className="tabular inline-flex rounded-lg bg-muted px-2.5 py-1 font-semibold">{formatWindow(a.startsAt, a.endsAt, tz)}</p>
        <p className="text-xs text-muted-foreground">{a.county}</p>
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
        {a.vapiCallId && (
          <Link href={`/calls/${encodeURIComponent(a.vapiCallId)}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink underline-offset-4 hover:underline">
            View call
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </Link>
        )}
      </div>
    </article>
  );
}
