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

/** Moon and sun glyphs for the compact header control; decorative only. */
function SchemeGlyph({ next }: { readonly next: ThemeChoice }) {
  return next === "dark" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * `variant="icon"` is the compact control in the site header; the default
 * text button remains for pages that still render their own masthead copy.
 * Both carry the same accessible name and behaviour. The name states the
 * action ("Switch to dark mode"), so the button deliberately has no
 * `aria-pressed`: a changing label plus a pressed state would announce
 * contradictions such as "Switch to light mode, pressed".
 */
export function ThemeToggle({ variant = "text" }: { readonly variant?: "text" | "icon" } = {}) {
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

  if (variant === "icon") {
    return (
      <button
        className="theme-toggle-icon"
        type="button"
        onClick={() => choose(next)}
        aria-label={label}
        title={label}
      >
        <SchemeGlyph next={next} />
      </button>
    );
  }

  return (
    <button
      className="btn-quiet theme-toggle"
      type="button"
      onClick={() => choose(next)}
      aria-label={label}
    >
      {label}
    </button>
  );
}
