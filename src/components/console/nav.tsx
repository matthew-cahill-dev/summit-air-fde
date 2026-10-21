"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDaysIcon, GaugeIcon, PhoneIcon, SirenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
type NavCounts = { openBoard: number; urgentOpen: number; callsToday: number };

export const NAV_ITEMS = [
  { href: "/dispatch", label: "Dispatch", icon: SirenIcon },
  { href: "/calls", label: "Calls", icon: PhoneIcon },
  { href: "/appointments", label: "Appointments", icon: CalendarDaysIcon },
  { href: "/overview", label: "Overview", icon: GaugeIcon },
] as const;

/** Page title for the header, from the path ("/calls/abc" → "Call"). */
export function titleForPath(pathname: string | null): string {
  if (!pathname) return "";
  if (/^\/calls\/[^/]+/.test(pathname)) return "Call";
  return NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))?.label ?? "";
}

/** The pathname is request data on dynamic routes, so the layout wraps this in Suspense. */
export function ConsoleNav({ counts }: { counts?: NavCounts | null }) {
  return <ConsoleNavLinks pathname={usePathname()} counts={counts} />;
}

/** Suspense fallback: the same links, no active state until the pathname streams in. */
export function ConsoleNavLinks({ pathname, counts }: { pathname: string | null; counts?: NavCounts | null }) {
  const badge: Partial<Record<string, { n: number; hot: boolean; label: string }>> = counts
    ? {
        "/dispatch": { n: counts.openBoard, hot: counts.urgentOpen > 0, label: `${counts.openBoard} open${counts.urgentOpen ? `, ${counts.urgentOpen} need attention now` : ""}` },
        "/calls": { n: counts.callsToday, hot: false, label: `${counts.callsToday} today` },
      }
    : {};
  return (
    <nav aria-label="Console" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname !== null && (pathname === href || pathname.startsWith(`${href}/`));
        const b = badge[href];
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground",
              active && "bg-card text-foreground shadow-card ring-1 ring-foreground/8",
            )}
          >
            {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" aria-hidden />}
            <Icon className={cn("size-4", active && "text-brand-ink")} aria-hidden />
            {label}
            {b && b.n > 0 && (
              <span
                className={cn(
                  "tabular ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold",
                  b.hot ? "bg-safety text-white" : "bg-foreground/8 text-muted-foreground",
                )}
                aria-label={b.label}
              >
                {b.n}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
