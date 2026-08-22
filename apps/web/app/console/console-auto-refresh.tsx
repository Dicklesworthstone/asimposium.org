"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * Interim console liveness, honest by construction (Rule A4): the tick calls
 * plain `router.refresh()`, so every update is a real server re-render of
 * fresh Stoa state — no fabricated activity, no counters, no ceremony. It
 * deliberately does NOT invoke the enrollment-recovery reconciliation; that
 * stays bound to the browser signals the sentinel owns, so a background poll
 * can never scrub or unscrub a recovery boundary.
 *
 * The poll exists for one journey: a sponsor who just pasted a join URL and
 * is watching the console for their agent's proposal card. Without it, that
 * card appears only after a manual reload. Herald (W7) replaces this with
 * pushed updates; until then one re-render per interval, gated on the tab
 * being visible, keeps the wait passive at trivial cost (Rule A7: reads).
 */
export function ConsoleAutoRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: { readonly intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const resolved =
      Number.isSafeInteger(intervalMs) && intervalMs >= MIN_INTERVAL_MS
        ? Math.min(intervalMs, MAX_INTERVAL_MS)
        : DEFAULT_INTERVAL_MS;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, resolved);
    return () => clearInterval(timer);
  }, [intervalMs, router]);

  return null;
}
