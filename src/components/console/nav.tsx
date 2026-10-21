"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDaysIcon, GaugeIcon, PhoneIcon, SirenIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/dispatch", label: "Dispatch", icon: SirenIcon },
  { href: "/calls", label: "Calls", icon: PhoneIcon },
  { href: "/appointments", label: "Appointments", icon: CalendarDaysIcon },
  { href: "/overview", label: "Overview", icon: GaugeIcon },
] as const;

/** The pathname is request data on dynamic routes, so the layout wraps this in Suspense. */
export function ConsoleNav() {
  return <ConsoleNavLinks pathname={usePathname()} />;
}

/** Suspense fallback: the same links, no active state until the pathname streams in. */
export function ConsoleNavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Console" className="flex flex-col gap-0.5">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname !== null && (pathname === href || pathname.startsWith(`${href}/`));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              active && "bg-muted text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
