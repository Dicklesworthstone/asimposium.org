import type { PublicLedgerWatch, PublicWatchState } from "./public-watch";

export interface PublicWatchBrowser {
  readonly document: Pick<Document, "visibilityState" | "activeElement" | "addEventListener" | "removeEventListener">;
  readonly window: Pick<Window, "navigator" | "getSelection" | "addEventListener" | "removeEventListener">;
}

/** No automatic replacement while the reader edits or selects scientific text.
 * Manual refresh remains available; body text cannot author a navigation. */
export function deferPublicWatchRefresh(browser: PublicWatchBrowser): boolean {
  const editing = browser.document.activeElement?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
  return editing != null || browser.window.getSelection()?.isCollapsed === false;
}

/** Visibility and connectivity are one cancellation boundary. Cleanup mirrors
 * setup, including React Strict Mode's mount/cleanup/remount cycle. */
export function bindPublicWatchBrowser(
  watch: Pick<PublicLedgerWatch, "start" | "stop" | "setActive">,
  enabled: boolean,
  browser: PublicWatchBrowser,
): () => void {
  const active = () => enabled && browser.document.visibilityState === "visible" &&
    browser.window.navigator.onLine !== false;
  const sync = () => watch.setActive(active());
  browser.document.addEventListener("visibilitychange", sync);
  browser.window.addEventListener("online", sync);
  browser.window.addEventListener("offline", sync);
  watch.start(active());
  return () => {
    browser.document.removeEventListener("visibilitychange", sync);
    browser.window.removeEventListener("online", sync);
    browser.window.removeEventListener("offline", sync);
    watch.stop();
  };
}

export function publicWatchStatusText(state: PublicWatchState): string {
  switch (state.status) {
    case "checking": return "Checking this view for public ledger changes.";
    case "current": return "No change detected in this view at the last check.";
    case "refreshing": return "A public record changed. Refreshing this view.";
    case "update-available": return "An update is available. Refresh this view when ready.";
    case "paused": return "Automatic checks are paused.";
    case "unavailable": return "Live checks are unavailable. These records are the last rendered snapshot.";
  }
}
