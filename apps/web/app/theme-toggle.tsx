"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

type ThemeChoice = "light" | "dark";
const STORAGE_KEY = "asimp-theme";
const THEME_COLORS: Record<ThemeChoice, string> = {
  light: "#f7f2e8",
  dark: "#14110e",
};

/** Browser chrome follows the page palette: every theme-color meta, one value. */
function reconcileThemeColorMetas(color: string): void {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = color;
  });
}

/**
 * The palette resolves from an explicit choice on <html>, else the OS
 * preference (Fable §8.3: light-first brand default, real dark mode). This
 * control records that explicit choice; until it is used, the site follows
 * the operating system exactly as before.
 *
 * The label derives from the document attribute through
 * `useSyncExternalStore` rather than component state: the attribute is the
 * single source of truth (the no-flash boot script may set it before React
 * exists), and the store contract re-syncs the snapshot after hydration, so
 * the label can never drift from the palette actually applied.
 */
const listeners = new Set<() => void>();

function currentTheme(): ThemeChoice {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onOsChange = (): void => {
    // An OS flip matters only while no explicit choice exists; the snapshot
    // re-read decides, so notifying unconditionally is harmless.
    onStoreChange();
  };
  const onStorageChange = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) {
      if (event.newValue === "light" || event.newValue === "dark") {
        document.documentElement.dataset.theme = event.newValue;
        reconcileThemeColorMetas(THEME_COLORS[event.newValue]);
      } else if (event.newValue === null) {
        delete document.documentElement.dataset.theme;
      }
      onStoreChange();
    }
  };
  media.addEventListener("change", onOsChange);
  window.addEventListener("storage", onStorageChange);
  return () => {
    listeners.delete(onStoreChange);
    media.removeEventListener("change", onOsChange);
    window.removeEventListener("storage", onStorageChange);
  };
}

function serverSnapshot(): ThemeChoice {
  // The server cannot know the client scheme; hydration re-syncs immediately.
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, serverSnapshot);

  const choose = useCallback((next: ThemeChoice) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage refusal keeps the choice for this document only; the palette
      // still switches, it just will not survive a reload.
    }
    reconcileThemeColorMetas(THEME_COLORS[next]);
    for (const listener of listeners) listener();
  }, []);

  // Hydration re-emits Next's managed <head> metadata after the boot script
  // ran, so a stored choice needs one reconciliation per applied-theme change
  // here as well - otherwise browser chrome lags the page palette until the
  // next explicit click.
  useEffect(() => {
    reconcileThemeColorMetas(THEME_COLORS[theme]);
  }, [theme]);

  const next: ThemeChoice = theme === "light" ? "dark" : "light";
  const label = next === "dark" ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button className="btn-quiet theme-toggle" type="button" onClick={() => choose(next)}>
      {label}
    </button>
  );
}
