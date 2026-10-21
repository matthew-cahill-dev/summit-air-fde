"use client";

import { useSyncExternalStore } from "react";
import { MonitorIcon, MoonIcon, PresentationIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { THEME_STORAGE_KEY as KEY, PRESENT_COOKIE } from "./theme-script";

type Theme = "light" | "dark" | "system";

const listeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (readTheme() === "system") apply("system");
  };
  media.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(cb);
    media.removeEventListener("change", onSystemChange);
  };
}

function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  apply(theme);
  listeners.forEach((l) => l());
}

export function ThemeMenu() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const Icon = theme === "dark" ? MoonIcon : theme === "light" ? SunIcon : MonitorIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" />}>
        <Icon />
        <span>Theme</span>
        <span className="ml-auto text-xs capitalize">{theme}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header icon button: flips light ⇄ dark (from "system", to the opposite of what's showing). */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const label = theme === "dark" ? "Switch to light theme" : theme === "light" ? "Switch to dark theme" : "Switch theme";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={() => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")}
    >
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
    </Button>
  );
}

// --- Presentation mode -----------------------------------------------------------
const presentListeners = new Set<() => void>();
const readPresent = () => document.documentElement.dataset.present === "1";
const subscribePresent = (cb: () => void) => {
  presentListeners.add(cb);
  return () => presentListeners.delete(cb);
};

export function setPresentation(on: boolean) {
  if (on) document.documentElement.dataset.present = "1";
  else delete document.documentElement.dataset.present;
  document.cookie = `${PRESENT_COOKIE}=${on ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  presentListeners.forEach((l) => l());
}

export function PresentationToggle() {
  const on = useSyncExternalStore(subscribePresent, readPresent, () => false);
  return (
    <Button
      variant={on ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={on}
      onClick={() => setPresentation(!on)}
      title="Presentation mode: larger type, less chrome, for screen sharing"
      className={cn("gap-1.5", on && "text-brand-ink")}
    >
      <PresentationIcon />
      <span className="hidden lg:inline">{on ? "Presenting" : "Present"}</span>
    </Button>
  );
}
