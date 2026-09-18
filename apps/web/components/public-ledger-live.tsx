"use client";

import type { PublicWatchTarget } from "@asimposium/contracts/public-watch";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { PublicLedgerWatch, type PublicWatchState } from "../lib/public-watch";
import {
  bindPublicWatchBrowser,
  deferPublicWatchRefresh,
  publicWatchStatusText,
} from "../lib/public-watch-browser";
import { parsePublicWatchManifest } from "../lib/public-watch-view";

const NOOP_ROUTER: ReturnType<typeof useRouter> = {
  back: () => {},
  forward: () => {},
  prefetch: () => {},
  push: () => {},
  refresh: () => {},
  replace: () => {},
  bfcacheId: "",
};

function useSafeRouter(): ReturnType<typeof useRouter> {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: useRouter throws outside AppRouterContext in SSR and unit tests
    return useRouter();
  } catch {
    return NOOP_ROUTER;
  }
}

/** A small client island: scientific content remains server-rendered and the
 * Worker remains its sole authority. No research body is fetched or interpreted
 * here. The exact URL's query, history cutoff and browser state stay in place. */
export function PublicLedgerLive({
  origin,
  targets,
}: {
  readonly origin: string;
  readonly targets: readonly PublicWatchTarget[];
}) {
  const router = useSafeRouter();
  const refreshRouter = useRef(router);
  useEffect(() => {
    refreshRouter.current = router;
  }, [router]);
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<PublicWatchState>({ status: "checking" });
  // A server refresh returning identical props must not reset retry limits or
  // create a fresh poller. Only changed rendered validators acknowledge progress.
  // Router context identity changes also must not reset the retry budget.
  const manifest = JSON.stringify(targets);

  useEffect(() => {
    const browser = { document, window };
    const location = `${window.location.pathname}${window.location.search}`;
    const watch = new PublicLedgerWatch({
      origin,
      targets: parsePublicWatchManifest(manifest),
      onState: setState,
      onRefresh: () => {
        if (
          `${window.location.pathname}${window.location.search}` !== location ||
          deferPublicWatchRefresh(browser)
        )
          return false;
        startTransition(() => refreshRouter.current.refresh());
        return true;
      },
    });
    const dispose = bindPublicWatchBrowser(watch, enabled, browser);
    return dispose;
  }, [origin, manifest, enabled]);

  return (
    <aside className="public-ledger-live" aria-label="Public ledger updates">
      <p className="quiet" role="status" aria-live="polite" aria-atomic="true">
        {publicWatchStatusText(state)}
      </p>
      <p>
        <button type="button" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}>
          {enabled ? "Pause automatic updates" : "Resume automatic updates"}
        </button>{" "}
        <button type="button" onClick={() => startTransition(() => router.refresh())}>
          Refresh this view
        </button>
      </p>
      <noscript>
        Automatic checks require JavaScript. Reload this page to refresh its public records.
      </noscript>
    </aside>
  );
}
