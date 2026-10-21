import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InfoIcon } from "lucide-react";
import { AppointmentItem } from "@/components/console/appointments-board";
import { FreshScope } from "@/components/console/live";
import { EmptyIllustration, ListSkeleton, PageHeader } from "@/components/console/page";
import { cn } from "@/lib/utils";
import { loadAppointments, type AppointmentsView } from "@/server/console/data";
import { formatDayHeading } from "@/server/console/format";

export const metadata: Metadata = { title: "Appointments" };

const VIEWS: Array<{ view: AppointmentsView | "booked_today"; label: string; help: string }> = [
  { view: "upcoming", label: "Upcoming", help: "Scheduled visits from today on, by day. Today's stay here until they're marked completed or no-show." },
  { view: "booked_today", label: "Booked today", help: "Appointments booked today, whatever day the visit is." },
  { view: "closed", label: "Closed", help: "Completed, no-show and cancelled visits from the last 7 days." },
];

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

export default function AppointmentsPage({ searchParams }: PageProps<"/appointments">) {
  return (
    <>
      <PageHeader
        title="Appointments"
        description="Confirmed arrival windows. Mark each visit completed or no-show, cancel to free its seat, or reschedule from live availability."
      />
      <Suspense fallback={<ListSkeleton rows={4} height="h-28" />}>
        <Schedule searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Schedule({ searchParams }: { searchParams: PageProps<"/appointments">["searchParams"] }) {
  const sp = await searchParams;
  const raw = str(sp.view);
  const view = raw === "closed" || raw === "booked_today" ? raw : "upcoming";
  const focus = str(sp.focus);
  const callbackId = str(sp.callback);
  const openReschedule = str(sp.reschedule) === "1";
  const { days, total, now, tz } = await loadAppointments({ view: view === "closed" ? "closed" : "upcoming", bookedToday: view === "booked_today" });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Appointment views" className="flex rounded-xl bg-muted p-1">
          {VIEWS.map((v) => (
            <Link
              key={v.view}
              href={v.view === "upcoming" ? "/appointments" : `/appointments?view=${v.view}`}
              aria-current={view === v.view ? "page" : undefined}
              title={v.help}
              className={cn(
                "inline-flex h-8 items-center rounded-lg px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                view === v.view && "bg-card text-foreground shadow-card",
              )}
            >
              {v.label}
            </Link>
          ))}
        </nav>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="size-3.5" aria-hidden />
          In production these sync with your field-service system (e.g. ServiceTitan).
        </p>
      </div>

      {days.length === 0 ? (
        <EmptyIllustration
          kind="calendar"
          title={view === "closed" ? "Nothing closed in the last 7 days" : view === "booked_today" ? "No bookings yet today" : "No upcoming appointments"}
          description={
            view === "closed"
              ? "Visits you mark completed, no-show or cancelled show here."
              : "Bookings made on calls show up here with their arrival window and technician notes."
          }
        />
      ) : (
        <FreshScope scope="appointments" ids={days.flatMap((d) => d.items.map((a) => a.id))}>
          <p className="tabular -mt-2 text-sm text-muted-foreground">
            {total} {view === "closed" ? "closed" : view === "booked_today" ? "booked today" : "upcoming"} across {days.length} day{days.length === 1 ? "" : "s"}
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
                      <AppointmentItem key={a.id} a={a} tz={tz} focus={a.id === focus} openReschedule={a.id === focus && openReschedule} callbackId={a.id === focus ? callbackId : null} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </FreshScope>
      )}
    </div>
  );
}
