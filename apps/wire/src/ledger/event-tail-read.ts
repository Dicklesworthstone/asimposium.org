import { BatchEventCauseSchema, MAX_CAUSED_BY_PER_MEMBER } from "@asimposium/contracts";
import {
  EVENT_TAIL_ID_PATTERN,
  EVENT_TAIL_MAX_BYTES,
  EVENT_TAIL_MAX_EVENTS,
  EVENT_TAIL_MAX_WAIT_SECONDS,
  EVENT_TAIL_OBJECT_ID_PATTERN,
  EVENT_TAIL_OMISSIONS,
  EVENT_TAIL_PROBLEM_PATTERN,
  EVENT_TAIL_SCHEMA_ID,
  type EventTailPage,
  type EventTailQuery,
  eventTailPath,
  type PublicEventEnvelope,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";

/** Structural read-only subset implemented by the real D1 binding. */
export interface EventTailDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

export class EventTailReadError extends Error {
  readonly code: "CURSOR_INVALID" | "EVENT_TAIL_UNAVAILABLE";
  constructor(code: "CURSOR_INVALID" | "EVENT_TAIL_UNAVAILABLE") {
    super(code);
    this.code = code;
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
  causal_json: string | null;
  causal_state: "recorded" | "not_recorded" | "unavailable";
}

// Explicit public producer census. Unknown/private/process producers do not
// gain disclosure merely because somebody inserts a new events.type value.
const PUBLIC_TYPES: Readonly<Record<string, readonly string[]>> = {
  claim: ["claim.created", "claim.revised", "claim.reanchored"],
  hypothesis: ["hypothesis.created", "hypothesis.killed", "hypothesis.deferred", "hypothesis.resumed", "hypothesis.narrowed", "hypothesis.superseded"],
  evidence: ["evidence.created"],
  review: ["review.created"],
  citation: ["citation.recorded", "citation.corrected"],
  dead_end: ["dead_end.recorded"],
  "dead-end": ["dead_end.recorded"],
  question: ["question.asked", "question.leased", "question.answered", "question.withdrawn"],
  conflict: ["conflict.normalized", "conflict.resolved"],
  retraction: ["object.retracted"],
  synthesis: ["synthesis.created"],
  gap: ["gap.filed", "gap.closed-by", "gap.withdrawn"],
  relation: ["relation.asserted", "relation.disputed"],
  "directive-disclosure": ["directive.disclosure-recorded"],
  problem: [
    "problem.admitted",
    "problem.published",
    "problem.statement-revised",
    "problem.statement-reviewed",
    "problem.dormant",
    "problem.result-review-started",
    "problem.resolved",
    "problem.retired",
  ],
};

function publicProducerSql(alias: string): string {
  return `(${Object.entries(PUBLIC_TYPES)
    .map(
      ([kind, types]) =>
        `(${alias}.object_kind = '${kind}' AND ${alias}.type IN (${types.map((type) => `'${type}'`).join(", ")}))`,
    )
    .join(" OR ")})`;
}

function availableContentSql(event: string, content: string): string {
  return `(${content}.event_id IS NOT NULL AND ${content}.redacted_at IS NULL
    AND NOT ${eventContentHiddenSql(event)})`;
}

// This subquery stays inside the same bounded read snapshot. A causal edge
// cannot disclose a private/unknown producer, an unavailable parent, another
// problem, or a forged event-id/sequence pair, even outside the current page.
const CAUSAL_PARENTS_AVAILABLE_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each(c.payload_json, '$.caused_by') cause
  LEFT JOIN events parent ON parent.problem_id = e.problem_id
    AND parent.id = CASE WHEN cause.type = 'object' THEN json_extract(cause.value, '$.event_id') END
    AND parent.seq = CASE WHEN cause.type = 'object' THEN json_extract(cause.value, '$.seq') END
  LEFT JOIN event_content parent_content ON parent_content.event_id = parent.id
    AND parent_content.payload_sha256 = parent.payload_sha256
  WHERE cause.type != 'object' OR parent.id IS NULL OR parent.seq >= e.seq
    OR NOT ${publicProducerSql("parent")}
    OR NOT ${availableContentSql("parent", "parent_content")}
)`;

const CAUSAL_STATE_SQL = `CASE
  WHEN ${availableContentSql("e", "c")} AND ${publicProducerSql("e")} THEN
    CASE WHEN json_valid(c.payload_json) THEN
      CASE WHEN json_type(c.payload_json, '$.caused_by') IS NULL THEN 'not_recorded'
        WHEN json_type(c.payload_json, '$.caused_by') = 'array'
          AND json_array_length(c.payload_json, '$.caused_by') <= ${MAX_CAUSED_BY_PER_MEMBER}
          AND length(CAST(json_extract(c.payload_json, '$.caused_by') AS BLOB)) <= 8192
          AND ${CAUSAL_PARENTS_AVAILABLE_SQL} THEN 'recorded'
        ELSE 'unavailable' END
      ELSE 'unavailable' END
  ELSE 'unavailable' END`;

/** One bounded SELECT captures visibility, head, page and content withdrawal.
 * Never return whole payloads, credential IDs, or mutable author/profile names.
 * Only the bounded causal field is extracted from hash-matched public content.
 * The sentinel row distinguishes an empty public ledger from a missing problem.
 */
/** A problem a current moderation control hides reads like a missing one on
 * every public tail, feed and wait (Fable §9.1 L2): no envelope leaks. */
export const PROBLEM_NOT_HIDDEN_SQL = `NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;

export const EVENT_TAIL_SELECT = `
WITH cut AS (
  SELECT id, public_seq, unlisted, COALESCE(?, public_seq) AS through
  FROM problems WHERE id = ? AND status != 'private-draft'
    AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
)
SELECT p.id AS problem_id, p.public_seq, p.through, p.unlisted, e.seq,
  CASE WHEN length(CAST(e.id AS BLOB)) <= 128 THEN e.id END AS id,
  CASE WHEN length(CAST(e.type AS BLOB)) <= 96 THEN e.type END AS type,
  CASE WHEN length(CAST(e.object_kind AS BLOB)) <= 32 THEN e.object_kind END AS object_kind,
  CASE WHEN length(CAST(e.object_id AS BLOB)) <= 256 THEN e.object_id END AS object_id,
  e.object_version,
  CASE WHEN length(e.created_at) = 24 THEN e.created_at END AS created_at,
  CASE WHEN length(e.payload_sha256) = 64 THEN e.payload_sha256 END AS payload_sha256,
  CASE WHEN length(CAST(e.actor_fellow_id AS BLOB)) <= 128 THEN e.actor_fellow_id END AS actor_fellow_id,
  CASE WHEN length(CAST(e.actor_sponsor_id AS BLOB)) <= 128 THEN e.actor_sponsor_id END AS actor_sponsor_id,
  CASE WHEN length(CAST(e.actor_session_id AS BLOB)) <= 128 THEN e.actor_session_id END AS actor_session_id,
  CASE WHEN length(CAST(e.model_string_self_declared AS BLOB)) <= 256 THEN e.model_string_self_declared END AS model_string_self_declared,
  CASE WHEN length(CAST(e.harness AS BLOB)) <= 256 THEN e.harness END AS harness,
  CASE WHEN ${availableContentSql("e", "c")} THEN 1 ELSE 0 END AS content_available,
  ${CAUSAL_STATE_SQL} AS causal_state,
  CASE WHEN (${CAUSAL_STATE_SQL}) = 'recorded'
    THEN json_extract(c.payload_json, '$.caused_by') END AS causal_json
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

function safeObjectId(value: unknown): value is string {
  return typeof value === "string" && EVENT_TAIL_OBJECT_ID_PATTERN.test(value);
}

function publicObjectUrl(problemId: string, row: TailRow, through: number): string | null {
  const prefix = `/p/${encodeURIComponent(problemId)}`;
  if (through > 999_999_999_999_999) return null;
  if (row.object_kind === "directive-disclosure" && /^DD-[a-f0-9]{32}$/.test(row.id ?? "")) {
    return `${prefix}/disclosures/${row.id}.json`;
  }
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
    !safeObjectId(row.object_id) ||
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
      ...publicCausality(row),
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
  // A full 15-parent batch can exceed the old envelope bound. Preserve each
  // complete record; the page builder accounts for their combined byte size.
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength <= 8192
    ? envelope
    : { ...base, event: null, body_omitted: "undisclosed_event" };
}

function publicCausality(
  row: TailRow,
): Pick<NonNullable<PublicEventEnvelope["event"]>, "caused_by" | "causality_omitted"> {
  if (row.causal_state === "not_recorded")
    return { caused_by: null, causality_omitted: "not_recorded" };
  const unavailable = { caused_by: null, causality_omitted: "unavailable" } as const;
  if (row.causal_state !== "recorded" || row.causal_json === null) return unavailable;
  try {
    const parsed = BatchEventCauseSchema.array()
      .max(MAX_CAUSED_BY_PER_MEMBER)
      .safeParse(JSON.parse(row.causal_json));
    if (!parsed.success) return unavailable;
    const parents = parsed.data;
    if (
      parents.some(
        (parent, index) =>
          parent.scope_id !== row.problem_id ||
          parent.seq >= (row.seq ?? 0) ||
          parent.event_id === row.id ||
          (index > 0 && parent.seq <= parents[index - 1]!.seq),
      ) ||
      new Set(parents.map((parent) => parent.event_id)).size !== parents.length
    )
      return unavailable;
    return { caused_by: parents, causality_omitted: null };
  } catch {
    return unavailable;
  }
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
    (query.through !== undefined && (!safeInteger(query.through) || query.through < query.since)) ||
    (query.wait !== undefined &&
      (!safeInteger(query.wait) || query.wait > EVENT_TAIL_MAX_WAIT_SECONDS))
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
  const events: PublicEventEnvelope[] = [];
  let eventBytes = 0;
  for (const row of rows.slice(0, query.limit)) {
    const event = publicEnvelope(row, through);
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    // Reserve completion, omission and SSE framing bytes. Resume after the
    // last whole event included, without dropping a long causal parent list.
    if (eventBytes + bytes > EVENT_TAIL_MAX_BYTES - 16 * 1024) break;
    events.push(event);
    eventBytes += bytes;
  }
  const nextCursor = query.since + events.length;
  const hasMore = nextCursor < through;
  const wait = query.wait === undefined ? {} : { wait: query.wait };
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
          ? eventTailPath(problemId, "json", {
              since: nextCursor,
              limit: query.limit,
              through,
              ...wait,
            })
          : null,
        poll: eventTailPath(problemId, "json", { since: nextCursor, limit: query.limit, ...wait }),
      },
      omitted: EVENT_TAIL_OMISSIONS,
    },
  };
}
