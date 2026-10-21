"use client";

import { useSyncExternalStore } from "react";
import { Toaster as Sonner } from "sonner";

const subscribe = (cb: () => void) => {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

/** Toasts (undo, confirmations) in the console's theme. */
export function Toaster() {
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains("dark"), () => false);
  return <Sonner theme={dark ? "dark" : "light"} position="bottom-right" closeButton toastOptions={{ classNames: { toast: "font-sans" } }} />;
}
