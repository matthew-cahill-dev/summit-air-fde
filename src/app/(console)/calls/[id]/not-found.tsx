import Link from "next/link";
import { PhoneOffIcon } from "lucide-react";
import { EmptyState } from "@/components/console/page";

export default function CallNotFound() {
  return (
    <div className="space-y-4">
      <EmptyState
        icon={PhoneOffIcon}
        title="Call not found"
        description="No tool activity or end-of-call report has this call ID. It may have been removed by db:reset-test."
      />
      <p className="text-center text-sm">
        <Link href="/calls" className="font-medium underline-offset-4 hover:underline">
          Back to all calls
        </Link>
      </p>
    </div>
  );
}
