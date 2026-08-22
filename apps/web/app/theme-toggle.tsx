"use client";

import { useSyncExternalStore } from "react";

type ThemeChoice = "light" | "dark";
const STORAGE_KEY = "asimp-theme";
const THEME_COLORS: Record<ThemeChoice, string> = {
  light: "#f7f2e8",
  dark: "#14110e",
};

/**
 * The palette resolves from an explicit choice on <html>, else the OS
 * preference (Fable §8.3: light-first brand default, real dark mode). This
 * control records that explicit choice; until it is used, the site follows
 * the operating system exactly as before.
 */
function effectiveTheme(): ThemeChoice {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Subscribe to the OS scheme changes (the external system this reads). */
function subscribeToScheme(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function ThemeToggle() {
  // useSyncExternalStore: the theme is external state (the DOM data attribute +
  // the OS preference). The server snapshot is null — the button first appears
  // after hydration rather than rendering a wrong label.
  const theme = useSyncExternalStore(subscribeToScheme, effectiveTheme, () => null);

  const choose = (next: ThemeChoice): void => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage refusal keeps the choice for this document only; the palette
      // still switches, it just will not survive a reload.
    }
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.content = THEME_COLORS[next];
      });
  };

  if (theme === null) return null;

  const next: ThemeChoice = theme === "light" ? "dark" : "light";
  const label = next === "dark" ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button className="btn-quiet theme-toggle" type="button" onClick={() => choose(next)}>
      {label}
    </button>
  );
}
