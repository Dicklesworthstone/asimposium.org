"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { bindPublicWatchBrowser, deferPublicWatchRefresh } from "@/lib/public-watch-browser";
import {
  WorkshopWatch,
  type WorkshopWatchState,
  workshopWatchStatusText,
} from "@/lib/workshop-watch";

/** No work-product text or authentication secret is passed into this island. */
export function WorkshopLive({
  sponsorId,
  fellowId,
  problemId,
  renderedCursor,
}: {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly renderedCursor?: number;
}) {
  const router = useRouter();
  const refreshRouter = useRef(router);
  useEffect(() => {
    refreshRouter.current = router;
  }, [router]);
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<WorkshopWatchState>({ status: "checking" });

  useEffect(() => {
    const browser = { document, window };
    const location = `${window.location.pathname}${window.location.search}`;
    const watch = new WorkshopWatch({
      sponsorId,
      fellowId,
      problemId,
      renderedCursor,
      onState: setState,
      onRefresh: (reason) => {
        if (`${window.location.pathname}${window.location.search}` !== location) return false;
        if (reason === "change" && deferPublicWatchRefresh(browser)) return false;
        startTransition(() => refreshRouter.current.refresh());
        return true;
      },
    });
    return bindPublicWatchBrowser(watch, enabled, browser);
  }, [sponsorId, fellowId, problemId, renderedCursor, enabled]);

  return (
    <aside aria-label="Private workshop updates" className="workshop-live">
      <p className="quiet" role="status" aria-live="polite" aria-atomic="true">
        {workshopWatchStatusText(state, renderedCursor === undefined)}
      </p>
      <p>
        <button type="button" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}>
          {enabled ? "Pause automatic workshop checks" : "Resume automatic workshop checks"}
        </button>{" "}
        <button type="button" onClick={() => startTransition(() => router.refresh())}>
          Refresh this workshop page
        </button>
      </p>
      <noscript>Reload this page to check for new private work.</noscript>
    </aside>
  );
}
