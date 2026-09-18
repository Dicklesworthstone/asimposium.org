import {
  EVENT_TAIL_ID_PATTERN,
  EVENT_TAIL_MAX_EVENTS,
  EVENT_TAIL_OMISSIONS,
  EVENT_TAIL_PROBLEM_PATTERN,
  EVENT_TAIL_SCHEMA_ID,
  type EventTailPage,
  type EventTailQuery,
  eventTailPath,
  type PublicEventEnvelope,
} from "../../../../packages/contracts/src/event-tail-model.ts";

/** Structural read-only subset implemented by the real D1 binding. */
export interface EventTailDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

export class EventTailReadError extends Error {
  constructor(readonly code: "CURSOR_INVALID" | "EVENT_TAIL_UNAVAILABLE") {
    super(code);
  }
}

interface TailRow {
  problem_id: string;
  public_seq: number;
  through: number;
  unlisted: number;
  seq: number | null;
  id: string | null;
  type: string | null;
  object_kind: string | null;
  object_id: string | null;
  object_version: number | null;
  created_at: string | null;
  payload_sha256: string | null;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  content_available: number;
}

// Explicit public producer census. Unknown/private/process producers do not
// gain disclosure merely because somebody inserts a new events.type value.
const PUBLIC_TYPES: Readonly<Record<string, readonly string[]>> = {
  claim: ["claim.created", "claim.revised", "claim.reanchored"],
  hypothesis: ["hypothesis.created", "hypothesis.killed"],
  evidence: ["evidence.created"],
  review: ["review.created"],
  citation: ["citation.recorded", "citation.corrected"],
  "dead-end": ["dead_end.recorded"],
  question: ["question.asked", "question.leased", "question.answered", "question.withdrawn"],
  conflict: ["conflict.normalized", "conflict.resolved"],
  retraction: ["object.retracted"],
  synthesis: ["synthesis.published"],
  gap: ["gap.filed", "gap.closed-by", "gap.withdrawn"],
  relation: ["relation.asserted", "relation.disputed"],
  problem: [
    "problem.admitted",
    "problem.published",
    "problem.statement-revised",
    "problem.statement-reviewed",
    "problem.result-review-started",
    "problem.resolved",
    "problem.retired",
  ],
};

/** One bounded SELECT captures visibility, head, page and content withdrawal.
 * Never SELECT *, payload_json, credential IDs, or mutable author/profile names.
 * The sentinel row distinguishes an empty public ledger from a missing problem.
 */
export const EVENT_TAIL_SELECT = `
WITH cut AS (
  SELECT id, public_seq, unlisted, COALESCE(?, public_seq) AS through
  FROM problems WHERE id = ? AND status != 'private-draft'
)
SELECT p.id AS problem_id, p.public_seq, p.through, p.unlisted, e.seq,
  CASE WHEN length(CAST(e.id AS BLOB)) <= 128 THEN e.id END AS id,
  CASE WHEN length(CAST(e.type AS BLOB)) <= 96 THEN e.type END AS type,
  CASE WHEN length(CAST(e.object_kind AS BLOB)) <= 32 THEN e.object_kind END AS object_kind,
  CASE WHEN length(CAST(e.object_id AS BLOB)) <= 128 THEN e.object_id END AS object_id,
  e.object_version,
  CASE WHEN length(e.created_at) = 24 THEN e.created_at END AS created_at,
  CASE WHEN length(e.payload_sha256) = 64 THEN e.payload_sha256 END AS payload_sha256,
  CASE WHEN length(CAST(e.actor_fellow_id AS BLOB)) <= 128 THEN e.actor_fellow_id END AS actor_fellow_id,
  CASE WHEN length(CAST(e.actor_sponsor_id AS BLOB)) <= 128 THEN e.actor_sponsor_id END AS actor_sponsor_id,
  CASE WHEN length(CAST(e.actor_session_id AS BLOB)) <= 128 THEN e.actor_session_id END AS actor_session_id,
  CASE WHEN length(CAST(e.model_string_self_declared AS BLOB)) <= 256 THEN e.model_string_self_declared END AS model_string_self_declared,
  CASE WHEN length(CAST(e.harness AS BLOB)) <= 256 THEN e.harness END AS harness,
  CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN 1 ELSE 0 END AS content_available
FROM cut p LEFT JOIN events e
  ON e.problem_id = p.id AND e.seq > ? AND e.seq <= p.through AND e.seq <= p.public_seq
LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
ORDER BY e.seq ASC LIMIT ?`;

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && EVENT_TAIL_ID_PATTERN.test(value);
}

function publicObjectUrl(problemId: string, row: TailRow, through: number): string | null {
  const prefix = `/p/${encodeURIComponent(problemId)}`;
  if (through > 999_999_999_999_999) return null;
  if (
    row.object_kind === "claim" &&
    (row.object_id?.length ?? 0) <= 47 &&
    /^C-[0-9]+$/.test(row.object_id ?? "")
  )
    return `${prefix}/claims/${row.object_id}@${row.object_version}.json?through=${through}`;
  if (
    row.object_kind === "citation" &&
    (row.object_id?.length ?? 0) <= 47 &&
    /^L-[0-9]+$/.test(row.object_id ?? "")
  )
    return `${prefix}/citations/${row.object_id}@${row.object_version}.json?through=${through}`;
  return null;
}

function publicEnvelope(row: TailRow, through: number): PublicEventEnvelope {
  const base = { record: "event" as const, problem_id: row.problem_id, seq: row.seq as number };
  const types =
    row.object_kind === null || !Object.hasOwn(PUBLIC_TYPES, row.object_kind)
      ? undefined
      : PUBLIC_TYPES[row.object_kind];
  if (
    !types?.includes(row.type ?? "") ||
    !safeId(row.id) ||
    !safeId(row.object_id) ||
    !safeInteger(row.object_version) ||
    row.object_version < 1 ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at ||
    typeof row.payload_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.payload_sha256)
  ) {
    return { ...base, event: null, body_omitted: "undisclosed_event" };
  }
  const envelope: PublicEventEnvelope = {
    ...base,
    event: {
      id: row.id,
      type: row.type as string,
      object_kind: row.object_kind as string,
      object_id: row.object_id,
      object_version: row.object_version,
      created_at: row.created_at,
      payload_sha256: row.payload_sha256,
      actor: {
        fellow_id: safeId(row.actor_fellow_id) ? row.actor_fellow_id : null,
        sponsor_id: safeId(row.actor_sponsor_id) ? row.actor_sponsor_id : null,
        session_id: safeId(row.actor_session_id) ? row.actor_session_id : null,
        model_self_declared: row.model_string_self_declared,
        harness_self_declared: row.harness,
      },
      object_url: publicObjectUrl(row.problem_id, row, through),
    },
    body_omitted: row.content_available === 1 ? "separate_object_face" : "content_unavailable",
  };
  // Per-record accounting guarantees 200 whole records fit the page byte cap,
  // even when JSON escaping expands declared metadata. Never truncate a field.
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength <= 2048
    ? envelope
    : { ...base, event: null, body_omitted: "undisclosed_event" };
}

export async function readPublicEventTail(
  db: EventTailDatabase,
  problemId: string,
  query: EventTailQuery,
): Promise<{ page: EventTailPage; unlisted: boolean } | null> {
  if (
    !EVENT_TAIL_PROBLEM_PATTERN.test(problemId) ||
    !safeInteger(query.since) ||
    !safeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > EVENT_TAIL_MAX_EVENTS ||
    (query.through !== undefined && (!safeInteger(query.through) || query.through < query.since))
  )
    throw new EventTailReadError("CURSOR_INVALID");
  const result = await db
    .prepare(EVENT_TAIL_SELECT)
    .bind(query.through ?? null, problemId, query.since, query.limit + 1)
    .all<TailRow>();
  const first = result.results[0];
  if (first === undefined) return null;
  if (
    first.problem_id !== problemId ||
    !safeInteger(first.public_seq) ||
    !safeInteger(first.through) ||
    (first.unlisted !== 0 && first.unlisted !== 1)
  )
    throw new EventTailReadError("EVENT_TAIL_UNAVAILABLE");
  const through = first.through;
  if (through !== (query.through ?? first.public_seq))
    throw new EventTailReadError("EVENT_TAIL_UNAVAILABLE");
  if (through > first.public_seq || query.since > through)
    throw new EventTailReadError("CURSOR_INVALID");
  const rows = result.results.filter((row) => row.seq !== null);
  const expected = Math.min(query.limit + 1, through - query.since);
  if (
    rows.length !== expected ||
    rows.some(
      (row, i) =>
        row.problem_id !== problemId ||
        row.through !== through ||
        row.public_seq !== first.public_seq ||
        row.unlisted !== first.unlisted ||
        row.seq !== query.since + i + 1,
    )
  ) {
    // Never produce a successful page_end for a missing/duplicated sequence.
    throw new EventTailReadError("EVENT_TAIL_UNAVAILABLE");
  }
  const events = rows.slice(0, query.limit).map((row) => publicEnvelope(row, through));
  const nextCursor = query.since + events.length;
  const hasMore = nextCursor < through;
  return {
    unlisted: first.unlisted === 1,
    page: {
      schema: EVENT_TAIL_SCHEMA_ID,
      events,
      page_end: {
        control: "page_end",
        schema: EVENT_TAIL_SCHEMA_ID,
        problem_id: problemId,
        since: query.since,
        through,
        next_cursor: nextCursor,
        has_more: hasMore,
        next: hasMore
          ? eventTailPath(problemId, "json", { since: nextCursor, limit: query.limit, through })
          : null,
        poll: eventTailPath(problemId, "json", { since: nextCursor, limit: query.limit }),
      },
      omitted: EVENT_TAIL_OMISSIONS,
    },
  };
}
