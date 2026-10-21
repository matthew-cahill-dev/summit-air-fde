"use client";

import { useActionState } from "react";
import { CircleAlertIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, { error: null });
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-2">
        <Label htmlFor="password">Dashboard password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "login-error" : undefined}
          className="h-10"
        />
        {state.error && (
          <p id="login-error" role="alert" className="animate-rise flex items-start gap-1.5 rounded-lg bg-safety-soft px-2.5 py-2 text-sm text-safety-ink">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {state.error}
          </p>
        )}
      </div>
      <Button type="submit" className="h-10 w-full bg-brand text-brand-foreground hover:bg-brand/90" disabled={pending}>
        {pending && <Loader2Icon className="animate-spin" aria-hidden />}
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
