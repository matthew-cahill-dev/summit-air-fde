"use client";

// "Your name": stored in this browser only, stamped on every board and appointment action
// ("Resolved 3:12 PM · Technician dispatched · by Dana"). Not an account: the console has one password.
import { useState, useSyncExternalStore } from "react";
import { UserRoundIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = "sa-operator-name";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setOperatorName(name: string) {
  try {
    localStorage.setItem(KEY, name.trim().slice(0, 60));
  } catch {
    // Storage blocked: the name lasts for this page view only.
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useOperatorName(): string {
  return useSyncExternalStore(subscribe, read, () => "");
}

/** Header control: shows who's acting, editable inline. Highlighted until a name is set. */
export function OperatorName() {
  const name = useOperatorName();
  const [editing, setEditing] = useState(false);
  if (editing || !name) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("name");
          if (typeof v === "string" && v.trim()) {
            setOperatorName(v);
            setEditing(false);
          }
        }}
        className="flex items-center gap-1.5"
      >
        <label htmlFor="operator-name" className="sr-only">
          Your name
        </label>
        <input
          id="operator-name"
          name="name"
          defaultValue={name}
          autoFocus={editing}
          placeholder="Your name"
          title="Stamped on what you do (called back, resolved, rescheduled). Kept in this browser."
          className={cn(
            "h-7 w-32 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
            !name && "border-urgent/60 bg-urgent-soft/40",
          )}
        />
      </form>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Your name, stamped on what you do. Click to change."
    >
      <UserRoundIcon className="size-3.5" aria-hidden />
      {name}
    </button>
  );
}
