import type { HypothesesResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";

export const HYPOTHESIS_PAGE_SIZE = 8;
export const HYPOTHESIS_CONTENT_BYTES = 96 * 1024;
const SCHEMA = "https://a.asimposium.org/schemas/hypotheses.v1.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface HypothesisDecoders {
  publication(value: unknown): PublicHypothesis["content"];
  kill(value: unknown): PublicHypothesis["kill"];
}
export interface HypothesisReadQuery {
  through?: number;
  after?: number;
}
export class HypothesisReadError extends Error {
  readonly code: "CURSOR_INVALID" | "HYPOTHESES_UNAVAILABLE";
  constructor(code: "CURSOR_INVALID" | "HYPOTHESES_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
}
export const HYPOTHESIS_HEAD_SQL = `SELECT id, public_seq,
  COALESCE(?, public_seq) AS cursor, unlisted
  FROM problems WHERE id = ? AND status <> 'private-draft'`;

/** First admission controls pagination, latest envelope controls lifecycle.
 * All content authority is in events/event_content; no hypothesis projection
 * is read. The same D1 transaction captures privacy, cursor and row bytes.
 * liveOnly excludes only a known terminal kill, not unknown lifecycle events. */
export const HYPOTHESIS_ROWS_SQL = `
WITH cut AS (
  SELECT id, COALESCE(?, public_seq) AS cursor FROM problems
  WHERE id = ? AND status <> 'private-draft'
    AND COALESCE(?, public_seq) <= public_seq
), admissions AS (
  SELECT e.object_id, MIN(e.seq) AS first_seq, COUNT(*) AS creations
  FROM events e JOIN cut p ON p.id = e.problem_id
  WHERE e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created' AND e.seq <= p.cursor
  GROUP BY e.object_id
), page AS (
  SELECT a.object_id, a.creations, c.id AS creation_id, h.id AS head_id
  FROM admissions a JOIN cut p
  JOIN events c ON c.problem_id = p.id AND c.seq = a.first_seq
  JOIN events h ON h.problem_id = p.id AND h.seq = (
    SELECT MAX(e.seq) FROM events e WHERE e.problem_id = p.id
      AND e.object_kind = 'hypothesis' AND e.object_id = a.object_id AND e.seq <= p.cursor
  )
  WHERE a.first_seq > ? AND (? = 0 OR h.type <> 'hypothesis.killed')
  ORDER BY a.first_seq LIMIT ?
)
SELECT p.object_id AS hypothesis_id, p.creations,
  c.problem_id, c.id AS event_id, c.seq, c.object_version, c.created_at, c.payload_sha256,
  c.actor_fellow_id AS fellow_id, c.actor_sponsor_id AS sponsor_id,
  c.actor_session_id AS session_id, c.model_string_self_declared AS model_self_declared,
  c.harness AS harness_self_declared,
  CASE WHEN cc.redacted_at IS NULL AND length(CAST(cc.payload_json AS BLOB)) <= ?
    THEN cc.payload_json END AS payload_json,
  h.id AS last_event_id, h.seq AS last_seq, h.type AS last_type, h.object_version AS last_version,
  h.created_at AS last_created_at, h.payload_sha256 AS last_payload_sha256,
  h.actor_fellow_id AS last_fellow_id, h.actor_sponsor_id AS last_sponsor_id,
  h.actor_session_id AS last_session_id, h.model_string_self_declared AS last_model_self_declared,
  h.harness AS last_harness_self_declared,
  CASE WHEN hc.redacted_at IS NULL AND length(CAST(hc.payload_json AS BLOB)) <= ?
    THEN hc.payload_json END AS last_payload_json
FROM page p JOIN events c ON c.id = p.creation_id JOIN events h ON h.id = p.head_id
LEFT JOIN event_content cc ON cc.event_id = c.id AND cc.payload_sha256 = c.payload_sha256
LEFT JOIN event_content hc ON hc.event_id = h.id AND hc.payload_sha256 = h.payload_sha256
ORDER BY c.seq`;

type Row = Record<string, unknown>;
function unavailable(): never {
  throw new HypothesisReadError("HYPOTHESES_UNAVAILABLE");
}
function sequence(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function envelope(row: Row, prefix = ""): PublicHypothesis["publication"] {
  const get = (key: string) => row[prefix + key];
  const id = get("event_id"),
    seq = get("seq"),
    at = get("created_at"),
    hash = get("payload_sha256");
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    !sequence(seq, 1) ||
    typeof at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
    !Number.isFinite(Date.parse(at)) ||
    new Date(at).toISOString() !== at ||
    typeof hash !== "string" ||
    !HASH.test(hash)
  )
    unavailable();
  const identity = (key: string) => {
    const value = get(key);
    if (value !== null && (typeof value !== "string" || !ID.test(value))) unavailable();
    return value as string | null;
  };
  const declaration = (key: string) => {
    const value = get(key);
    if (value !== null && (typeof value !== "string" || value.length > 256)) unavailable();
    return value as string | null;
  };
  return {
    event_id: id,
    seq,
    created_at: at,
    payload_sha256: hash,
    fellow_id: identity("fellow_id"),
    sponsor_id: identity("sponsor_id"),
    session_id: identity("session_id"),
    model_self_declared: declaration("model_self_declared"),
    harness_self_declared: declaration("harness_self_declared"),
  };
}
async function verifiedContent(raw: unknown, expected: string): Promise<unknown> {
  if (typeof raw !== "string") return undefined;
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length > HYPOTHESIS_CONTENT_BYTES) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== expected) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** liveOnly and limit are internal selection controls, never public query fields. */
export async function readHypotheses(
  db: D1Database,
  problemId: string,
  query: HypothesisReadQuery,
  decoders: HypothesisDecoders,
  selection: { liveOnly?: boolean; limit?: number } = {},
): Promise<{ face: HypothesesResponse; unlisted: boolean } | null> {
  const after = query.after ?? 0;
  const limit = selection.limit ?? HYPOTHESIS_PAGE_SIZE;
  if (
    !/^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(problemId) ||
    !sequence(after) ||
    (query.through !== undefined && (!sequence(query.through) || query.through < after))
  )
    throw new HypothesisReadError("CURSOR_INVALID");
  if (!sequence(limit, 1) || limit > HYPOTHESIS_PAGE_SIZE) unavailable();
  const through = query.through ?? null;
  const result = await db.batch([
    db.prepare(HYPOTHESIS_HEAD_SQL).bind(through, problemId),
    db
      .prepare(HYPOTHESIS_ROWS_SQL)
      .bind(
        through,
        problemId,
        through,
        after,
        selection.liveOnly ? 1 : 0,
        limit + 1,
        HYPOTHESIS_CONTENT_BYTES,
        HYPOTHESIS_CONTENT_BYTES,
      ),
  ]);
  if (
    result.length !== 2 ||
    !Array.isArray(result[0]?.results) ||
    !Array.isArray(result[1]?.results)
  )
    unavailable();
  const head = result[0].results[0] as Row | undefined;
  if (!head) return null;
  if (
    result[0].results.length !== 1 ||
    head.id !== problemId ||
    !sequence(head.public_seq) ||
    !sequence(head.cursor) ||
    (head.unlisted !== 0 && head.unlisted !== 1)
  )
    unavailable();
  const cursor = head.cursor;
  if (cursor > head.public_seq || after > cursor) throw new HypothesisReadError("CURSOR_INVALID");
  const rows = result[1].results as Row[];
  if (rows.length > limit + 1) unavailable();
  const items: PublicHypothesis[] = [];
  const omissions = new Set<HypothesesResponse["omitted"][number]>();
  const ids = new Set<string>();
  let previous = after;
  for (const row of rows.slice(0, limit)) {
    const id = row.hypothesis_id;
    if (
      row.problem_id !== problemId ||
      typeof id !== "string" ||
      !/^H-[0-9]{1,78}$/.test(id) ||
      ids.has(id)
    )
      unavailable();
    ids.add(id);
    const publication = envelope(row),
      last = envelope(row, "last_");
    if (publication.seq <= previous || publication.seq > last.seq || last.seq > cursor)
      unavailable();
    previous = publication.seq;
    let status: PublicHypothesis["status"] =
      row.creations !== 1 || row.object_version !== 1 || row.last_version !== 1
        ? "unavailable"
        : row.last_type === "hypothesis.killed"
          ? "killed"
          : row.last_type === "hypothesis.created" && publication.event_id === last.event_id
            ? "active"
            : "unavailable";
    const content = decoders.publication(
      await verifiedContent(row.payload_json, publication.payload_sha256),
    );
    let kill =
      status === "killed"
        ? decoders.kill(await verifiedContent(row.last_payload_json, last.payload_sha256))
        : null;
    if (kill !== null && kill.hypothesis_id !== id) {
      kill = null;
      status = "unavailable";
    }
    if (content === null || (status === "killed" && kill === null))
      omissions.add("content_unavailable");
    if (status === "unavailable") omissions.add("lifecycle_unavailable");
    items.push({ hypothesis_id: id, status, publication, content, last_event: last, kill });
  }
  const next = rows.length > limit ? previous : null;
  if (next !== null) omissions.add("page_limit");
  return {
    face: {
      schema: SCHEMA,
      problem_id: problemId,
      cursor,
      after,
      hypotheses: items,
      next_after: next,
      omitted: [...omissions],
    },
    unlisted: head.unlisted === 1,
  };
}
