/** A public sequence is navigation data, never posting authority. */
export function commentaryCursorFromQuery(
  value: string | readonly string[] | undefined,
): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

export function commentaryPageHref(problemId: string, cursor = 0): string {
  return `/console/commentary/${encodeURIComponent(problemId)}${cursor === 0 ? "" : `?cursor=${cursor}`}`;
}

/** A receipt link starts immediately before its immutable commentary entry,
 * so a post remains reachable after the first public discussion page fills. */
export function publicCommentaryHref(
  problemId: string,
  entry?: { readonly seq: number; readonly commentary_id: string },
): string {
  const cursor = entry === undefined ? 0 : Math.max(0, entry.seq - 1);
  return `/p/${encodeURIComponent(problemId)}${cursor === 0 ? "" : `?commentary_cursor=${cursor}`}#${entry === undefined ? "commentary-heading" : `commentary-${entry.commentary_id}`}`;
}
// Twenty maximum-sized, JSON-escaped entries fit the public reader's 1 MiB
// bound, including all ten references on every entry.
export const COMMENTARY_PAGE_SIZE = 20;
