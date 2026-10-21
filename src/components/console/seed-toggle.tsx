"use client";

import { useOptimistic, useTransition } from "react";
import { setHideSeedAction, setShowTestsAction } from "@/app/(console)/actions";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

function PreferenceSwitch({ id, label, title, on, save }: { id: string; label: string; title: string; on: boolean; save: (on: boolean) => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(on);
  return (
    <div className="flex items-center gap-2" title={title}>
      <Switch
        id={id}
        size="sm"
        checked={optimistic}
        disabled={pending}
        onCheckedChange={(next) =>
          startTransition(async () => {
            setOptimistic(next);
            await save(next);
          })
        }
      />
      <Label htmlFor={id} className="text-xs font-medium whitespace-nowrap text-muted-foreground">
        {label}
      </Label>
    </div>
  );
}

/** Seed data (fictional demo customers and calls). Off by default. */
export function SeedToggle({ hidden }: { hidden: boolean }) {
  return (
    <PreferenceSwitch
      id="show-seed"
      label="Seed data"
      title="Show the fictional demo data from npm run db:seed"
      on={!hidden}
      save={(show) => setHideSeedAction(!show)}
    />
  );
}

/** Test runs (Vapi simulations, web calls, dashboard tool tests). Off by default; never in real KPIs. */
export function TestRunsToggle({ shown }: { shown: boolean }) {
  return (
    <PreferenceSwitch
      id="show-tests"
      label="Test runs"
      title="Show Vapi simulations, web calls and dashboard tests. They're never counted unless this is on."
      on={shown}
      save={setShowTestsAction}
    />
  );
}
