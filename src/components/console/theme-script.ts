// Plain module (not "use client") so the root layout can inline the string.
export const THEME_STORAGE_KEY = "sa-theme";
/** Presentation mode (bigger type, less chrome for screen sharing): a plain UI cookie. */
export const PRESENT_COOKIE = "sa_present";

/** Runs in <head> before first paint: applies the saved theme (or the OS setting) and presentation mode. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light";if(/(?:^|; )${PRESENT_COOKIE}=1/.test(document.cookie))e.dataset.present="1"}catch(_){}})()`;
