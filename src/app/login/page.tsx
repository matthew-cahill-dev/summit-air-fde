import type { Metadata } from "next";
import { Suspense } from "react";
import { ShieldCheckIcon } from "lucide-react";
import { BrandMark } from "@/components/console/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const next = (await searchParams).next;
  return <LoginForm next={typeof next === "string" ? next : ""} />;
}

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-background p-6">
      {/* Soft brand glow and a horizon line: quiet, on-brand, no image assets. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_-10%,var(--brand-soft),transparent_70%)]" />
      <svg aria-hidden viewBox="0 0 1440 200" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full text-brand opacity-[0.07]">
        <path d="M0 200 L260 70 L420 150 L640 30 L860 140 L1040 60 L1240 150 L1440 90 L1440 200 Z" fill="currentColor" />
      </svg>
      <div className="relative w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Summit Air Operations</h1>
            <p className="text-sm text-muted-foreground">Dispatch, calls and appointments in one place</p>
          </div>
        </div>
        <div className="shadow-raised rounded-2xl bg-card p-6 ring-1 ring-foreground/8">
          <Suspense fallback={<LoginForm next="" />}>
            <Form searchParams={searchParams} />
          </Suspense>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" aria-hidden />
          Staff only. Sessions expire automatically.
        </p>
      </div>
    </main>
  );
}
