import type { HypothesisEvidenceIndexResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content";
import { HypothesisReadError } from "./hypotheses-read";

export const HYPOTHESIS_EVIDENCE_PAGE_SIZE = 8;
export const HYPOTHESIS_EVIDENCE_SOURCE_BYTES = 512 * 1024;
export const HYPOTHESIS_EVIDENCE_PAGE_BYTES = 1024 * 1024;

type Envelope = PublicHypothesis["publication"];
type Summary = HypothesisEvidenceIndexResponse["evidence"][number];
export interface HypothesisEvidenceIndexDecoders {
  envelope(value: unknown): Envelope | null;
  hypothesis(value: unknown): PublicHypothesis["content"];
  evidence(value: unknown): Pick<Summary, "direction" | "kind" | "mode"> & {
    bears_on_kind: "hypothesis";
    bears_on_id: string;
  } | null;
}

// Both statements capture one cut and current visibility in the same batch.
// Index rows locate exact publications; they never supply authored text or a
// scientific class. A missing/corrupt projection can omit a source, so the face
// expressly identifies itself as an index, not an exhaustive ledger export.
const CUT = `WITH cut AS (
  SELECT p.id, p.public_seq, p.unlisted, COALESCE(?, p.public_seq) AS cursor, ? AS target
  FROM problems p WHERE p.id = ? AND p.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
), target AS (
  SELECT p.*, h.id AS hypothesis_event, h.seq AS hypothesis_seq, h.object_version,
    h.payload_sha256 AS hypothesis_sha256,
    h.created_at, h.actor_fellow_id, h.actor_sponsor_id, h.actor_session_id,
    h.model_string_self_declared, h.harness,
    (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id AND e.object_id = p.target
      AND e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created' AND e.seq <= p.cursor) AS admissions,
    CASE WHEN c.redacted_at IS NULL AND c.payload_sha256 = h.payload_sha256
      AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND ${HYPOTHESIS_EVIDENCE_SOURCE_BYTES}
      THEN c.payload_json END AS hypothesis_json
  FROM cut p LEFT JOIN events h ON h.id = (
    SELECT e.id FROM events e WHERE e.problem_id = p.id AND e.object_id = p.target
      AND e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created' AND e.seq <= p.cursor
    ORDER BY e.seq LIMIT 1
  ) LEFT JOIN event_content c ON c.event_id = h.id
  WHERE NOT ${hiddenByContentControlSql("p.id", "p.target")}
)`;
export const HYPOTHESIS_EVIDENCE_INDEX_HEAD_SQL = `${CUT} SELECT * FROM target`;
export const HYPOTHESIS_EVIDENCE_INDEX_ROWS_SQL = `${CUT}, page AS (
  SELECT e.id AS event_id, e.problem_id, e.object_id AS evidence_id, e.seq, e.created_at,
    e.payload_sha256, e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
    e.model_string_self_declared, e.harness,
    length(CAST(c.payload_json AS BLOB)) AS payload_bytes,
    CASE WHEN c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
      AND NOT ${hiddenByContentControlSql("p.id", "e.object_id")}
      THEN 1 ELSE 0 END AS visible,
    c.payload_json,
    EXISTS (SELECT 1 FROM scientific_withdrawals w JOIN events we
      ON we.id = w.event_id AND we.problem_id = w.problem_id AND we.seq = w.seq
      AND we.payload_sha256 = w.event_sha256 AND we.type = 'object.retracted'
      AND we.object_kind = 'retraction' AND we.object_id = w.retraction_id
      WHERE w.problem_id = p.id AND w.target_kind = 'evidence'
        AND w.target_object = e.object_id AND w.source_event_id = e.id
        AND w.source_sha256 = e.payload_sha256 AND we.seq <= p.cursor) AS withdrawn
  FROM target p JOIN evidence x ON x.problem_id = p.id
    AND x.bears_on_kind = 'hypothesis' AND x.bears_on_id = p.target AND x.bears_on_version IS NULL
  JOIN events e ON e.id = x.source_event_id AND e.problem_id = x.problem_id
    AND e.seq = x.source_seq AND e.object_id = x.evidence_id AND e.object_version = 1
    AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
    AND e.actor_fellow_id = x.author_fellow_id AND e.seq > p.hypothesis_seq AND e.seq <= p.cursor
  LEFT JOIN event_content c ON c.event_id = e.id
  WHERE p.admissions = 1 AND p.object_version = 1 AND p.cursor <= p.public_seq
    AND p.hypothesis_json IS NOT NULL AND e.seq > ?
  ORDER BY e.seq, e.id LIMIT ${HYPOTHESIS_EVIDENCE_PAGE_SIZE + 1}
), budgeted AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY seq, event_id) AS ordinal,
    SUM(CASE WHEN visible = 1 AND payload_bytes BETWEEN 1 AND ${HYPOTHESIS_EVIDENCE_SOURCE_BYTES}
      THEN payload_bytes ELSE 0 END) OVER (ORDER BY seq, event_id) AS cumulative_bytes
  FROM page
)
SELECT event_id, problem_id, evidence_id, seq, created_at, payload_sha256,
  actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness,
  withdrawn,
  CASE WHEN visible = 1 AND (payload_bytes > ${HYPOTHESIS_EVIDENCE_SOURCE_BYTES}
    OR cumulative_bytes > ${HYPOTHESIS_EVIDENCE_PAGE_BYTES}) THEN 1 ELSE 0 END AS over_budget,
  CASE WHEN ordinal <= ${HYPOTHESIS_EVIDENCE_PAGE_SIZE} AND visible = 1
    AND payload_bytes BETWEEN 1 AND ${HYPOTHESIS_EVIDENCE_SOURCE_BYTES}
    AND cumulative_bytes <= ${HYPOTHESIS_EVIDENCE_PAGE_BYTES} THEN payload_json END AS payload_json
FROM budgeted ORDER BY seq, event_id`;

type Row = Record<string, unknown>;
const safeSequence = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const fail = (): never => { throw new HypothesisReadError("HYPOTHESES_UNAVAILABLE"); };
async function source(raw: unknown, hash: unknown): Promise<unknown> {
  if (typeof raw !== "string" || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length > HYPOTHESIS_EVIDENCE_SOURCE_BYTES) return undefined;
  const result = await crypto.subtle.digest("SHA-256", bytes);
  if ([...new Uint8Array(result)].map(b => b.toString(16).padStart(2,"0")).join("") !== hash) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}
function envelopeInput(row: Row, hypothesis = false): Record<string, unknown> {
  return {
    event_id: hypothesis ? row.hypothesis_event : row.event_id,
    seq: hypothesis ? row.hypothesis_seq : row.seq,
    payload_sha256: hypothesis ? row.hypothesis_sha256 : row.payload_sha256,
    created_at: row.created_at, fellow_id: row.actor_fellow_id, sponsor_id: row.actor_sponsor_id,
    session_id: row.actor_session_id, model_self_declared: row.model_string_self_declared,
    harness_self_declared: row.harness,
  };
}

/** Read-only discovery. Direction and mode are authored evidence vocabulary,
 * never an independent verdict, a disposition, or a count of replications. */
export async function readHypothesisEvidenceIndex(
  db: D1Database,
  problemId: string,
  hypothesisId: string,
  query: { through?: number; after?: number },
  decode: HypothesisEvidenceIndexDecoders,
): Promise<{ face: HypothesisEvidenceIndexResponse; unlisted: boolean } | null> {
  const after = query.after ?? 0, through = query.through ?? null;
  if (!/^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(problemId) ||
    !PublicHypothesisIdSchema.safeParse(hypothesisId).success || !safeSequence(after) ||
    (through !== null && (!safeSequence(through) || through < after)))
    throw new HypothesisReadError("CURSOR_INVALID");
  const result = await db.batch([
    db.prepare(HYPOTHESIS_EVIDENCE_INDEX_HEAD_SQL).bind(through, hypothesisId, problemId),
    db.prepare(HYPOTHESIS_EVIDENCE_INDEX_ROWS_SQL).bind(through, hypothesisId, problemId, after),
  ]);
  if (result.length !== 2 || !Array.isArray(result[0]?.results) || !Array.isArray(result[1]?.results)) fail();
  const head = result[0].results[0] as Row | undefined;
  if (!head) return null;
  if (result[0].results.length !== 1 || head.id !== problemId || head.target !== hypothesisId ||
    !safeSequence(head.cursor) || !safeSequence(head.public_seq) || (head.unlisted !== 0 && head.unlisted !== 1)) fail();
  if (head.cursor > head.public_seq || after > head.cursor) throw new HypothesisReadError("CURSOR_INVALID");
  if (head.hypothesis_event === null) return null;
  if (head.admissions !== 1 || head.object_version !== 1) fail();
  const publication = decode.envelope(envelopeInput(head, true));
  if (!publication || publication.seq > head.cursor) fail();
  // Without a verified visible parent, do not expose even a reference index.
  if (decode.hypothesis(await source(head.hypothesis_json, head.hypothesis_sha256)) === null) return null;
  const rows = result[1].results as Row[];
  if (rows.length > HYPOTHESIS_EVIDENCE_PAGE_SIZE + 1) fail();
  const omitted = new Set<HypothesisEvidenceIndexResponse["omitted"][number]>(["index_scope"]);
  const evidence: Summary[] = [];
  const ids = new Set<string>(), events = new Set<string>();
  let scannedThrough = after;
  for (const row of rows.slice(0,HYPOTHESIS_EVIDENCE_PAGE_SIZE)) {
    if (!safeSequence(row.seq,1) || row.seq <= scannedThrough || row.seq > head.cursor ||
      row.problem_id !== problemId || (row.withdrawn !== 0 && row.withdrawn !== 1)) fail();
    scannedThrough = row.seq;
    const decoded = decode.evidence(await source(row.payload_json,row.payload_sha256));
    const pin = decode.envelope(envelopeInput(row));
    if (!pin || !decoded || decoded.bears_on_kind !== "hypothesis" || decoded.bears_on_id !== hypothesisId ||
      typeof row.evidence_id !== "string" || !/^E-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/.test(row.evidence_id)) {
      omitted.add(row.over_budget === 1 ? "payload_budget" : "content_unavailable");
      continue;
    }
    if (ids.has(row.evidence_id) || events.has(pin.event_id) || pin.seq !== row.seq) fail();
    ids.add(row.evidence_id); events.add(pin.event_id);
    evidence.push({ evidence_id: row.evidence_id, publication: pin,
      direction: decoded.direction, kind: decoded.kind, mode: decoded.mode,
      withdrawn: row.withdrawn === 1,
      read_url: `/p/${encodeURIComponent(problemId)}/evidence/${row.evidence_id}.json` });
  }
  const next = rows.length > HYPOTHESIS_EVIDENCE_PAGE_SIZE ? scannedThrough : null;
  if (next !== null) omitted.add("page_limit");
  return {
    face: { schema: "asimposium.hypothesis-evidence-index.v1", problem_id: problemId,
      hypothesis_id: hypothesisId, hypothesis_publication: publication, cursor: head.cursor,
      after, scanned: Math.min(rows.length,HYPOTHESIS_EVIDENCE_PAGE_SIZE), scanned_through: scannedThrough,
      evidence, next_after: next, omitted: [...omitted] },
    unlisted: head.unlisted === 1,
  };
}
