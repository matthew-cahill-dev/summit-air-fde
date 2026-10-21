"use client";

import { useOptimistic, useTransition } from "react";
import { setHideSeedAction } from "@/app/(console)/actions";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function SeedToggle({ hidden }: { hidden: boolean }) {
  const [pending, startTransition] = useTransition();
  const [optimisticHidden, setOptimisticHidden] = useOptimistic(hidden);
  return (
    <div className="flex items-center gap-2">
      <Switch
        id="show-seed"
        size="sm"
        checked={!optimisticHidden}
        disabled={pending}
        onCheckedChange={(show) =>
          startTransition(async () => {
            setOptimisticHidden(!show);
            await setHideSeedAction(!show);
          })
        }
      />
      <Label htmlFor="show-seed" className="text-xs font-medium text-muted-foreground">
        Show seed data
      </Label>
    </div>
  );
}
