/** Bounded, read-only continuation; tokens confer no access to any resource. */
export const SEARCH_WINDOW_MAX = 500;
export const SEARCH_CURSOR_MAX_LENGTH = 140;
export const SEARCH_CURSOR_PATTERN = /^sc1\.[0-9a-f]{64}\.[0-9a-f]{64}\.[1-9][0-9]{0,2}$/;

export interface SearchPageQuery {
  readonly q: string;
  readonly kind?: "all" | "problem" | "claim" | "fellow";
  readonly limit?: number;
  readonly cursor?: string;
}

/** Preserve the complete query on every human/agent continuation link. */
export function searchQueryString(query: SearchPageQuery): string {
  const params = new URLSearchParams({ q: query.q, kind: query.kind ?? "all", limit: String(query.limit ?? 20) });
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return params.toString();
}
