import { SEARCH_CURSOR_PATTERN, SEARCH_WINDOW_MAX, type SearchPageQuery } from "@asimposium/contracts/search-pagination";

export class SearchContinuationError extends Error {
  constructor(readonly reason: "invalid" | "changed") {
    super(reason === "invalid" ? "Invalid search continuation." : "Search results changed; restart the search.");
    this.name = "SearchContinuationError";
  }
}
export interface SearchContinuation {
  readonly offset: number;
  readonly queryDigest: string;
  readonly windowDigest?: string;
}
export async function searchDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate before any lookup. Binding is to the normalized query, filter,
 * page size and algorithm version, not a caller-selected SQL rank/offset. */
export async function readSearchContinuation(query: SearchPageQuery): Promise<SearchContinuation> {
  const limit = query.limit ?? 20;
  if (typeof query.q !== "string" || !query.q.trim() || query.q.length > 256 || query.q.includes("\0") ||
      !["all", "claim", "problem", "fellow"].includes(query.kind ?? "all") ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new SearchContinuationError("invalid");
  const queryDigest = await searchDigest(["search-window-v1", query.q.trim(), query.kind ?? "all", limit]);
  if (query.cursor === undefined) return { offset: 0, queryDigest };
  if (typeof query.cursor !== "string" || SEARCH_CURSOR_PATTERN.exec(query.cursor)?.[0] !== query.cursor) {
    throw new SearchContinuationError("invalid");
  }
  const [, boundQuery, windowDigest, offsetText] = query.cursor.split(".");
  const offset = Number(offsetText);
  if (boundQuery !== queryDigest || !windowDigest || !Number.isSafeInteger(offset) ||
      offset < 1 || offset >= SEARCH_WINDOW_MAX || offset % limit !== 0) throw new SearchContinuationError("invalid");
  return { offset, queryDigest, windowDigest };
}

export async function bindSearchWindow(
  continuation: SearchContinuation,
  entries: readonly unknown[],
  truncated: boolean,
): Promise<string> {
  const digest = await searchDigest(["search-window-v1", entries, truncated]);
  if (continuation.windowDigest !== undefined && continuation.windowDigest !== digest) {
    throw new SearchContinuationError("changed");
  }
  if (continuation.offset >= entries.length && continuation.offset !== 0) throw new SearchContinuationError("changed");
  return digest;
}
export function nextSearchCursor(queryDigest: string, windowDigest: string, offset: number): string {
  if (!/^[0-9a-f]{64}$/.test(queryDigest) || !/^[0-9a-f]{64}$/.test(windowDigest) ||
      !Number.isSafeInteger(offset) || offset < 1 || offset >= SEARCH_WINDOW_MAX) {
    throw new SearchContinuationError("invalid");
  }
  return `sc1.${queryDigest}.${windowDigest}.${offset}`;
}
