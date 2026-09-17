import type { SearchResultItem } from "@asimposium/contracts";
import type { SearchPageQuery } from "@asimposium/contracts/search-pagination";
import type { D1Database } from "@cloudflare/workers-types";
import { bindSearchWindow, nextSearchCursor, type SearchContinuation } from "./continuation.ts";
import { hydrateSearchPage, readSearchWindow } from "./window.ts";

export interface SearchPage {
  items: SearchResultItem[];
  cursor: string | null;
  windowMatches: number;
  truncated: boolean;
}

/** Both the window and the selected bodies are read from current public
 * sources, including on a continuation/conditional request. A cursor stores
 * hashes and a bounded position, never retained withdrawn content. */
export async function executeSearchPage(
  db: D1Database,
  request: SearchPageQuery,
  ftsQuery: string,
  exactItems: readonly SearchResultItem[],
  continuation: SearchContinuation,
  refreshExact: () => Promise<readonly SearchResultItem[]>,
): Promise<SearchPage> {
  const window = await readSearchWindow(db, request, ftsQuery, exactItems);
  const digest = await bindSearchWindow(continuation, window.entries, window.truncated);
  const limit = request.limit ?? 20;
  const end = Math.min(continuation.offset + limit, window.entries.length);
  const items = await hydrateSearchPage(
    db,
    window.entries.slice(continuation.offset, end),
    ftsQuery,
  );
  // D1 reads need not share a transaction. Recheck after hydration so an index
  // update, withdrawal, visibility flip, or exact-target revision between the
  // two reads cannot silently shift a page or return an old cached excerpt.
  const current = await readSearchWindow(db, request, ftsQuery, await refreshExact());
  await bindSearchWindow(
    { ...continuation, windowDigest: digest },
    current.entries,
    current.truncated,
  );
  return {
    items,
    cursor:
      end < window.entries.length ? nextSearchCursor(continuation.queryDigest, digest, end) : null,
    windowMatches: window.entries.length,
    truncated: window.truncated,
  };
}
