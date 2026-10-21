// Plain module (not "use client") so the root layout can inline the string.
export const THEME_STORAGE_KEY = "sa-theme";

/** Runs in <head> before first paint: applies the saved theme, or the OS setting. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light"}catch(_){}})()`;
