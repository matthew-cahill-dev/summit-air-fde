import { Suspense } from "react";
import { LogOutIcon } from "lucide-react";
import { BrandLockup } from "@/components/console/brand";
import { ConsoleHeader } from "@/components/console/header";
import { ConsoleNav, ConsoleNavLinks } from "@/components/console/nav";
import { SeedToggle } from "@/components/console/seed-toggle";
import { ThemeMenu } from "@/components/console/theme";
import { Button } from "@/components/ui/button";
import { loadNavCounts, readHideSeed } from "@/server/console/data";
import { logoutAction } from "./actions";

async function SeedPreference() {
  return <SeedToggle hidden={await readHideSeed()} />;
}

async function NavWithCounts() {
  return <ConsoleNav counts={await loadNavCounts()} />;
}

export default function ConsoleLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <BrandLockup className="px-2 pb-6" />
        <p className="present-hide px-2.5 pb-2 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Workspace</p>
        <Suspense fallback={<ConsoleNavLinks pathname={null} />}>
          <NavWithCounts />
        </Suspense>
        <div className="present-hide mt-auto space-y-1 border-t pt-3">
          <ThemeMenu />
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start text-muted-foreground">
              <LogOutIcon />
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ConsoleHeader
          seedToggle={
            <Suspense fallback={<SeedToggle hidden />}>
              <SeedPreference />
            </Suspense>
          }
        />
        <main className="console-main mx-auto w-full max-w-[1500px] flex-1 space-y-6 px-6 py-7 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
