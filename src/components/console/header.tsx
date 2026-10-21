"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LiveRefresh } from "./live";
import { titleForPath } from "./nav";
import { PresentationToggle, ThemeToggle } from "./theme";

/** Sticky top bar: page title, live status, seed toggle (slot), presentation and theme toggles. */
export function ConsoleHeader({ seedToggle }: { seedToggle: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-background/80 px-6 backdrop-blur-md lg:px-8">
      {/* The pathname is request data on dynamic routes: its own Suspense boundary. */}
      <Suspense fallback={<span />}>
        <HeaderTitle />
      </Suspense>
      <div className="ml-auto flex items-center gap-3">
        <LiveRefresh />
        <span aria-hidden className="h-5 w-px bg-border" />
        <div className="present-hide">{seedToggle}</div>
        <span aria-hidden className="present-hide h-5 w-px bg-border" />
        <PresentationToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

function HeaderTitle() {
  return <p className="truncate text-sm font-semibold tracking-tight">{titleForPath(usePathname())}</p>;
}
