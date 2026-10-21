import { Suspense } from "react";
import { LogOutIcon, MountainIcon } from "lucide-react";
import { ConsoleNav, ConsoleNavLinks } from "@/components/console/nav";
import { LiveRefresh } from "@/components/console/live";
import { SeedToggle } from "@/components/console/seed-toggle";
import { ThemeMenu } from "@/components/console/theme";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { readHideSeed } from "@/server/console/data";
import { logoutAction } from "./actions";

async function SeedPreference() {
  return <SeedToggle hidden={await readHideSeed()} />;
}

export default function ConsoleLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 flex h-svh w-56 shrink-0 flex-col border-r bg-sidebar px-3 py-4">
        <div className="flex items-center gap-2.5 px-2.5 pb-5">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MountainIcon className="size-4" aria-hidden />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">Summit Air</p>
            <p className="text-xs text-muted-foreground">Operations</p>
          </div>
        </div>
        <Suspense fallback={<ConsoleNavLinks pathname={null} />}>
          <ConsoleNav />
        </Suspense>
        <div className="mt-auto space-y-1">
          <Separator className="mb-2" />
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
        <div className="sticky top-0 z-10 flex h-12 items-center justify-end gap-5 border-b bg-background/85 px-8 backdrop-blur">
          <Suspense fallback={<SeedToggle hidden />}>
            <SeedPreference />
          </Suspense>
          {/* A plain rule: the Separator's self-stretch plus a fixed height pins it to the top of the bar. */}
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          <LiveRefresh />
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-8 py-7">{children}</main>
      </div>
    </div>
  );
}
