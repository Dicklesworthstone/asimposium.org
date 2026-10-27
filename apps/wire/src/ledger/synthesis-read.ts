import type { SynthesisItem } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import type { SynthesisAnchorSource } from "./synthesis-references.ts";

export const SYNTHESIS_READ_LIMIT = 200;
// The public schema permits many anchors and disclosed omissions as well as
// the body. Keep a complete valid work product readable; bound the page as a
// whole rather than silently truncating a field.
export const SYNTHESIS_READ_BYTES = 6 * 1024 * 1024;

export interface SynthesisReadOptions {
  readonly through?: number;
  readonly limit?: number;
  readonly synthesisId?: string;
}

export interface SynthesisReadPage {
  readonly found: boolean;
  readonly cursor: number;
  readonly items: readonly {
    synthesis: SynthesisItem;
    materialEventsSince: number;
    source: SynthesisAnchorSource;
  }[];
  readonly omitted: string[];
}

export class SynthesisReadError extends Error {
  readonly code: "CURSOR_INVALID" | "SOURCE_UNAVAILABLE";
  constructor(code: "CURSOR_INVALID" | "SOURCE_UNAVAILABLE") {
    super(`SYNTHESIS_${code}`);
    this.code = code;
  }
}

/** The source is the ledger, not the rebuildable syntheses table. One SELECT
 * captures publication, privacy, source bytes and staleness at the same cut.
 * Current hides/redactions override old cursors. A lookahead proves truncation
 * without transferring its body, and the whole page has a UTF-8 byte ceiling. */
export const SYNTHESIS_READ_SQL = `
WITH scope AS (
  SELECT id, public_seq, COALESCE(?, public_seq) AS cursor
  FROM problems WHERE id = ? AND status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
    AND NOT ${hiddenByContentControlSql("problems.id", "problems.id")}
), publications AS (
  SELECT e.*,
    (SELECT COUNT(*) FROM events duplicate
     WHERE duplicate.problem_id = e.problem_id AND duplicate.object_id = e.object_id
       AND duplicate.object_kind = 'synthesis' AND duplicate.type = 'synthesis.created'
       AND duplicate.seq <= p.cursor) AS publications
  FROM scope p JOIN events e ON e.problem_id = p.id
  WHERE e.seq <= p.cursor AND p.cursor <= p.public_seq
    AND e.object_kind = 'synthesis' AND e.type = 'synthesis.created'
    AND (? IS NULL OR e.object_id = ?)
  ORDER BY e.seq DESC LIMIT ?
), sources AS (
  SELECT e.*, c.payload_json,
    CASE WHEN c.redacted_at IS NULL AND c.payload_json IS NOT NULL
      AND NOT ${eventContentHiddenSql("e")}
      THEN 1 ELSE 0 END AS available,
    COALESCE(length(CAST(c.payload_json AS BLOB)), 0) AS body_bytes
  FROM publications e LEFT JOIN event_content c
    ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
), budgeted AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY seq DESC) AS ordinal,
    SUM(CASE WHEN available = 1 THEN body_bytes ELSE 0 END)
      OVER (ORDER BY seq DESC ROWS UNBOUNDED PRECEDING) AS page_bytes
  FROM sources
)
SELECT p.id AS problem_id, p.public_seq, p.cursor,
  e.id AS event_id, e.object_id AS synthesis_id, e.object_version,
  e.seq, e.created_at, e.payload_sha256, e.publications, e.ordinal,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
  e.actor_session_id AS session_id, e.model_string_self_declared AS declared_model,
  e.harness, e.available,
  CASE WHEN e.available = 1 AND e.page_bytes > ? THEN 1 ELSE 0 END AS byte_limit,
  CASE WHEN e.ordinal <= ? AND e.available = 1 AND e.page_bytes <= ?
    THEN e.payload_json END AS payload_json,
  CASE WHEN ? = 1 AND e.available = 1 AND e.page_bytes <= ?
      AND json_valid(e.payload_json)
    THEN (SELECT COUNT(*) FROM events newer
      WHERE newer.problem_id = p.id AND newer.seq <= p.cursor
        AND newer.seq > json_extract(e.payload_json, '$.covers_through')
        AND newer.object_kind IN ('claim','hypothesis','review','evidence','dead_end','conflict','gap'))
    ELSE 0 END AS material_events_since
FROM scope p LEFT JOIN budgeted e ON 1
ORDER BY e.seq DESC`;

type Row = Record<string, unknown>;
function sequence(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Production supplies SynthesisItemSchema.safeParse. This seam isolates SQL
 * and integrity tests; neither HTTP query fields nor published content can
 * replace the canonical decoder. No free-form author field grants standing. */
export async function readSynthesisPage(
  db: D1Database,
  problemId: string,
  options: SynthesisReadOptions,
  decode: (value: unknown) => SynthesisItem | null,
): Promise<SynthesisReadPage> {
  const requestedLimit = options.limit ?? 50;
  if (
    !text(problemId, 128) || problemId.includes("\0") ||
    !Number.isSafeInteger(requestedLimit) ||
    (options.through !== undefined && !sequence(options.through)) ||
    (options.synthesisId !== undefined &&
      (!text(options.synthesisId, 128) || options.synthesisId.includes("\0")))
  ) throw new SynthesisReadError("CURSOR_INVALID");
  // Preserve the existing list limit clamp; exact reads never scan page one
  // and then look for an older id in a truncated list.
  const limit = options.synthesisId === undefined
    ? Math.min(Math.max(requestedLimit, 1), SYNTHESIS_READ_LIMIT) : 1;
  const result = await db.prepare(SYNTHESIS_READ_SQL).bind(
    options.through ?? null, problemId,
    options.synthesisId ?? null, options.synthesisId ?? null, limit + 1,
    SYNTHESIS_READ_BYTES, limit, SYNTHESIS_READ_BYTES,
    options.synthesisId === undefined ? 0 : 1, SYNTHESIS_READ_BYTES,
  ).all<Row>();
  if (!Array.isArray(result.results) || result.results.length > limit + 1)
    throw new SynthesisReadError("SOURCE_UNAVAILABLE");
  const rows = result.results;
  const head = rows[0];
  if (!head) return { found: false, cursor: 0, items: [], omitted: ["problem not found"] };
  if (head.problem_id !== problemId || !sequence(head.public_seq) || !sequence(head.cursor))
    throw new SynthesisReadError("SOURCE_UNAVAILABLE");
  if (head.cursor > head.public_seq) throw new SynthesisReadError("CURSOR_INVALID");
  if (options.through !== undefined && head.cursor !== options.through)
    throw new SynthesisReadError("SOURCE_UNAVAILABLE");
  if (head.event_id === null) {
    if (rows.length !== 1) throw new SynthesisReadError("SOURCE_UNAVAILABLE");
    return { found: true, cursor: head.cursor, items: [], omitted: [] };
  }
  const omitted = new Set<string>();
  if (rows.length > limit) omitted.add("page_limit");
  const items: SynthesisReadPage["items"][number][] = [];
  let previous: number | undefined;
  const seen = new Set<string>();
  for (const row of rows.slice(0, limit)) {
    if (
      row.problem_id !== problemId || row.cursor !== head.cursor ||
      row.public_seq !== head.public_seq || !sequence(row.seq, 1) ||
      row.seq > head.cursor || (previous !== undefined && row.seq >= previous) ||
      !text(row.synthesis_id, 128) || seen.has(row.synthesis_id) ||
      (options.synthesisId !== undefined && row.synthesis_id !== options.synthesisId)
    ) throw new SynthesisReadError("SOURCE_UNAVAILABLE");
    previous = row.seq;
    seen.add(row.synthesis_id);
    if (row.byte_limit === 1) omitted.add("byte_limit");
    if (
      row.available !== 1 || row.byte_limit === 1 ||
      row.publications !== 1 || row.object_version !== 1 ||
      !text(row.event_id, 128) || !timestamp(row.created_at) ||
      !text(row.fellow_id, 128) || !text(row.sponsor_id, 128) ||
      !text(row.session_id, 128) || !text(row.declared_model, 256) ||
      !text(row.harness, 256) || typeof row.payload_json !== "string" ||
      typeof row.payload_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.payload_sha256)
    ) { omitted.add("content_unavailable"); continue; }
    const bytes = new TextEncoder().encode(row.payload_json);
    if (bytes.byteLength > SYNTHESIS_READ_BYTES) {
      omitted.add("byte_limit");
      continue;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== row.payload_sha256) { omitted.add("content_unavailable"); continue; }
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); }
    catch { omitted.add("content_unavailable"); continue; }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      omitted.add("content_unavailable"); continue;
    }
    const p = payload as Record<string, unknown>;
    if (
      (p.synthesis_id !== undefined && p.synthesis_id !== row.synthesis_id) ||
      (p.problem_id !== undefined && p.problem_id !== problemId) ||
      !sequence(p.covers_through) || p.covers_through >= row.seq ||
      !sequence(p.dropped_single_author_count) || !sequence(row.material_events_since)
    ) { omitted.add("content_unavailable"); continue; }
    const synthesis = decode({
      synthesis_id: row.synthesis_id, problem_id: problemId, seq: row.seq,
      covers_through: p.covers_through, body_md: p.body_md, anchors: p.anchors,
      omitted: p.omitted, selection_policy: p.selection_policy,
      ...(p.closing_resolution !== undefined ? { closing_resolution: p.closing_resolution } : {}),
      dropped_single_author_count: p.dropped_single_author_count,
      authoring_principal: row.fellow_id, declared_model: row.declared_model,
      sponsor_id: row.sponsor_id, session_id: row.session_id,
      harness: row.harness, created_at: row.created_at,
    });
    if (synthesis === null) { omitted.add("content_unavailable"); continue; }
    items.push({ synthesis, materialEventsSince: row.material_events_since, source: {
      eventId: row.event_id, payloadDigest: row.payload_sha256,
      payloadJson: row.payload_json, problemId, seq: row.seq,
    } });
  }
  return { found: true, cursor: head.cursor, items, omitted: [...omitted] };
}
