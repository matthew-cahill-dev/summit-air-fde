import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarXIcon, KeyRoundIcon } from "lucide-react";
import { MemberBadge, SeedTag, UrgencyBadge } from "@/components/console/badges";
import { FreshRow, FreshScope } from "@/components/console/live";
import { EmptyState, PageHeader, TableSkeleton } from "@/components/console/page";
import { Table, TableBody, TableCell, TableHead, TableHeader } from "@/components/ui/table";
import { loadAppointments } from "@/server/console/data";
import { formatDayHeading, formatPhone, formatWindow, serviceLabel } from "@/server/console/format";

export const metadata: Metadata = { title: "Appointments" };

export default function AppointmentsPage() {
  return (
    <>
      <PageHeader title="Appointments" description="Upcoming confirmed arrival windows, by day." />
      <Suspense fallback={<TableSkeleton rows={6} />}>
        <Schedule />
      </Suspense>
    </>
  );
}

async function Schedule() {
  const { days, now, tz } = await loadAppointments();
  if (days.length === 0) {
    return (
      <EmptyState
        icon={CalendarXIcon}
        title="No upcoming appointments"
        description="Bookings made on calls show up here with their arrival window and technician notes."
      />
    );
  }
  return (
    <FreshScope scope="appointments" ids={days.flatMap((d) => d.items.map((a) => a.id))}>
      <div className="space-y-8">
        {days.map((day) => (
          <section key={day.key} aria-labelledby={`day-${day.key}`} className="space-y-3">
            <h2 id={`day-${day.key}`} className="flex items-baseline gap-2 text-sm font-semibold">
              {formatDayHeading(day.first, tz, now)}
              <span className="font-normal text-muted-foreground">
                {day.items.length} appointment{day.items.length === 1 ? "" : "s"}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              <Table className="table-fixed">
                <TableHeader>
                  <tr className="border-b">
                    <TableHead className="w-32 pl-4">Window</TableHead>
                    <TableHead className="w-[19%]">Customer</TableHead>
                    <TableHead className="w-[22%]">Address</TableHead>
                    <TableHead className="w-28">Service</TableHead>
                    <TableHead className="pr-4">Technician notes</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {day.items.map((a) => (
                    <FreshRow key={a.id} id={a.id} className="border-b align-top last:border-0">
                      <TableCell className="pl-4 align-top font-medium tabular-nums">
                        {formatWindow(a.startsAt, a.endsAt, tz)}
                        <div className="text-xs font-normal text-muted-foreground">{a.county}</div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{a.customerName}</span>
                          {a.isMember && <MemberBadge />}
                          <SeedTag show={a.isDemoSeed} />
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">{formatPhone(a.customerPhone)}</div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <div>
                          {a.line1}
                          {a.unit && `, Unit ${a.unit}`}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {a.city} {a.zip}
                        </div>
                        {a.accessNotes && (
                          <div className="mt-1 flex gap-1 text-xs text-muted-foreground">
                            <KeyRoundIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                            <span className="line-clamp-2" title={a.accessNotes}>
                              {a.accessNotes}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="space-y-1 align-top whitespace-normal">
                        <div>{serviceLabel(a.serviceType)}</div>
                        <UrgencyBadge urgency={a.urgency} />
                      </TableCell>
                      <TableCell className="pr-4 align-top whitespace-normal">
                        {a.issueSummary && <p className="font-medium">{a.issueSummary}</p>}
                        {a.technicianNotes ? (
                          <TechnicianNotes notes={a.technicianNotes} />
                        ) : (
                          !a.issueSummary && <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </FreshRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}
      </div>
    </FreshScope>
  );
}

function TechnicianNotes({ notes }: { notes: string }) {
  const long = notes.length > 160 || notes.split("\n").length > 2;
  if (!long) return <p className="mt-0.5 text-xs whitespace-pre-line text-muted-foreground">{notes}</p>;
  return (
    <div className="group/notes mt-0.5 text-xs text-muted-foreground">
      <p className="line-clamp-2 whitespace-pre-line group-has-[details[open]]/notes:hidden">{notes}</p>
      <details className="group">
        <summary className="cursor-pointer list-none font-medium text-foreground underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show all notes</span>
          <span className="hidden group-open:inline">Show less</span>
        </summary>
        <p className="mt-1 whitespace-pre-line">{notes}</p>
      </details>
    </div>
  );
}
