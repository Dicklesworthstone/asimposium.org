import {
  type EventTailPage,
  type EventTailQuery,
  EventTailQuerySchema,
  eventTailPath,
  parseEventTailQuery,
} from "@asimposium/contracts/event-tail";

export type EventHistoryQuery = Omit<EventTailQuery, "wait">;

/** Browser history pages never long-poll. The canonical contract owns cursor
 * syntax, bounds and duplicate/unknown-parameter rejection. */
export function parseEventHistoryQuery(value: unknown): EventHistoryQuery | null {
  const parsed = EventTailQuerySchema.safeParse(value);
  if (!parsed.success || parsed.data.wait !== undefined) return null;
  const params = new URLSearchParams();
  for (const [key, entry] of Object.entries(parsed.data)) {
    if (entry !== undefined) params.set(key, entry);
  }
  return parseEventTailQuery(params) ?? null;
}

export function eventHistoryPath(problemId: string, query?: EventHistoryQuery): string {
  const path = `/p/${encodeURIComponent(problemId)}/events`;
  if (query === undefined) return path;
  return eventTailPath(problemId, "json", query).replace("/events.json?", "/events?");
}

export function publicEventPath(problemId: string, sequence: number): string {
  return `/r/p/${encodeURIComponent(problemId)}/events/${sequence}`;
}

/** Only a contract-validated continuation from this problem is translated
 * into human navigation. Preserve its snapshot pin and cursor byte-for-byte. */
export function eventHistoryContinuation(problemId: string, path: string): string | null {
  const prefix = `/p/${encodeURIComponent(problemId)}/events.json?`;
  if (!path.startsWith(prefix)) return null;
  const params = new URLSearchParams(path.slice(prefix.length));
  if (params.getAll("wait").length !== 0) return null;
  const query = parseEventTailQuery(params);
  if (query === undefined || eventTailPath(problemId, "json", query) !== path) return null;
  return path.replace("/events.json?", "/events?");
}

/** Event URLs may only point back into the same problem's public record.
 * Reject URL normalization tricks before rendering even a server-supplied link. */
export function publicEventObjectPath(problemId: string, path: string | null): string | null {
  if (path === null || !path.startsWith(`/p/${encodeURIComponent(problemId)}/`)) return null;
  try {
    const url = new URL(path, "https://event-history.invalid");
    return url.origin === "https://event-history.invalid" &&
      url.hash === "" && `${url.pathname}${url.search}` === path
      ? path
      : null;
  } catch {
    return null;
  }
}

/** Schema validity alone does not bind a response to the requested snapshot.
 * A different valid page must never be displayed under this history URL. */
export function eventHistoryMatchesQuery(
  page: EventTailPage,
  problemId: string,
  query: EventHistoryQuery,
): boolean {
  const end = page.page_end;
  if (
    end.problem_id !== problemId || end.since !== query.since ||
    (query.through !== undefined && end.through !== query.through) ||
    page.events.length > query.limit ||
    page.events.some((entry) => entry.problem_id !== problemId ||
      (entry.event?.object_url != null &&
        publicEventObjectPath(problemId, entry.event.object_url) === null))
  ) return false;
  const next = end.has_more
    ? eventTailPath(problemId, "json", { since: end.next_cursor, limit: query.limit, through: end.through })
    : null;
  return end.next === next && end.poll === eventTailPath(problemId, "json", {
    since: end.next_cursor, limit: query.limit,
  });
}
