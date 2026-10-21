import type { Metadata } from "next";
import Link from "next/link";
import { SearchXIcon } from "lucide-react";
import { EmptyState } from "@/components/console/page";

export const metadata: Metadata = { title: "Not found" };

// Served with a real 404 for any unmatched URL, and for unknown call IDs (the proxy
// rewrites those here; see src/server/console/call-not-found.ts).
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 space-y-4 px-8 py-16">
      <EmptyState
        icon={SearchXIcon}
        title="Not found"
        description="That page or call doesn't exist. A call ID stops resolving if db:reset-test removed it."
      />
      <p className="flex justify-center gap-6 text-sm">
        <Link href="/calls" className="font-medium underline-offset-4 hover:underline">
          All calls
        </Link>
        <Link href="/dispatch" className="font-medium underline-offset-4 hover:underline">
          Dispatch board
        </Link>
      </p>
    </main>
  );
}
