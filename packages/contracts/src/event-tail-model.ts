/** W6.4 cursor and envelope law. No clock, database, or rendering dependency. */
export const EVENT_TAIL_SCHEMA_ID = "https://a.asimposium.org/schemas/event-tail.v1.json";
export const EVENT_TAIL_MAX_EVENTS = 200;
export const EVENT_TAIL_DEFAULT_LIMIT = 50;
export const EVENT_TAIL_MAX_BYTES = 512 * 1024;
export const EVENT_TAIL_CURSOR_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/;
export const EVENT_TAIL_PROBLEM_PATTERN = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const EVENT_TAIL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface EventTailQuery {
  readonly since: number;
  readonly limit: number;
  readonly through?: number;
}

export interface PublicEventEnvelope {
  readonly record: "event";
  readonly problem_id: string;
  readonly seq: number;
  readonly event: null | {
    readonly id: string;
    readonly type: string;
    readonly object_kind: string;
    readonly object_id: string;
    readonly object_version: number;
    readonly created_at: string;
    readonly payload_sha256: string;
    /** Event actor snapshot; never relabeled as the scientific content author. */
    readonly actor: {
      readonly fellow_id: string | null;
      readonly sponsor_id: string | null;
      readonly session_id: string | null;
      readonly model_self_declared: string | null;
      readonly harness_self_declared: string | null;
    };
    readonly object_url: string | null;
  };
  readonly body_omitted: "separate_object_face" | "content_unavailable" | "undisclosed_event";
}

export interface EventTailPageEnd {
  readonly control: "page_end";
  readonly schema: typeof EVENT_TAIL_SCHEMA_ID;
  readonly problem_id: string;
  readonly since: number;
  readonly through: number;
  readonly next_cursor: number;
  readonly has_more: boolean;
  readonly next: string | null;
  readonly poll: string;
}

export interface EventTailPage {
  readonly schema: typeof EVENT_TAIL_SCHEMA_ID;
  readonly events: readonly PublicEventEnvelope[];
  readonly page_end: EventTailPageEnd;
  readonly omitted: readonly string[];
}

export const EVENT_TAIL_OMISSIONS = [
  "Event envelopes only; bodies are read through public object faces. An event does not establish scientific standing.",
  "Undisclosed events retain only their problem-local sequence. Credentials and private work are never included.",
] as const;

export function eventTailCursor(value: string): number | undefined {
  if (!EVENT_TAIL_CURSOR_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Reject unknown/repeated parameters rather than silently changing a resume request. */
export function parseEventTailQuery(params: URLSearchParams): EventTailQuery | undefined {
  for (const key of params.keys()) {
    if (!["since", "limit", "through"].includes(key) || params.getAll(key).length !== 1)
      return undefined;
  }
  const since = eventTailCursor(params.get("since") ?? "0");
  const limit = eventTailCursor(params.get("limit") ?? String(EVENT_TAIL_DEFAULT_LIMIT));
  const throughText = params.get("through");
  const through = throughText === null ? undefined : eventTailCursor(throughText);
  if (
    since === undefined ||
    limit === undefined ||
    limit < 1 ||
    limit > EVENT_TAIL_MAX_EVENTS ||
    (throughText !== null && (through === undefined || through < since))
  )
    return undefined;
  return { since, limit, ...(through === undefined ? {} : { through }) };
}

export function eventTailPath(
  problem: string,
  format: "json" | "ndjson",
  query: EventTailQuery,
): string {
  const params = new URLSearchParams({ since: String(query.since), limit: String(query.limit) });
  if (query.through !== undefined) params.set("through", String(query.through));
  return `/p/${encodeURIComponent(problem)}/events.${format}?${params}`;
}

/** A completed NDJSON page always has exactly one final control line, even when empty. */
export function renderEventTail(page: EventTailPage, format: "json" | "ndjson"): string {
  if (format === "json") return `${JSON.stringify(page)}\n`;
  const end = {
    ...page.page_end,
    next: page.page_end.next?.replace("/events.json?", "/events.ndjson?") ?? null,
    poll: page.page_end.poll.replace("/events.json?", "/events.ndjson?"),
    omitted: page.omitted,
  };
  return `${[...page.events.map((event) => JSON.stringify(event)), JSON.stringify(end)].join("\n")}\n`;
}
