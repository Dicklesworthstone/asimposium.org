import {
  ClaimIdSchema,
  ClaimKindSchema,
  EvidenceRequestSchema,
  HypothesisRequestSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import {
  EvidenceListEntrySchema,
  type EvidenceListResponse,
  EvidenceListResponseSchema,
  RESEARCH_LIST_PAGE_SIZE,
  RESEARCH_LISTS_SCHEMA_ID,
  type ResearchListQuery,
} from "@asimposium/contracts/research-lists";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import { checkedScientificPayload, ScientificInputError } from "./scientific-checks.ts";

export class EvidenceListReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`EVIDENCE_LIST_${code}`);
  }
}

const SOURCE_BYTES = 512 * 1024;
const PAGE_BYTES = 1024 * 1024;
const CUT = `WITH cut AS (
  SELECT id, public_seq, unlisted, COALESCE(?1, public_seq) AS cursor
  FROM problems WHERE id = ?2 AND status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
)`;
const HEAD_SQL = `${CUT} SELECT id, public_seq, unlisted, cursor FROM cut`;

/** Select immutable admissions before any content joins. Every examined
 * envelope advances the page even if today's controls withhold its body. The
 * lookahead supplies no payload, and the SQL byte budget covers source and
 * target together rather than transferring unbounded scientific histories. */
const PAGE_SQL = `${CUT}, admissions AS (
  SELECT e.* FROM cut p JOIN events e ON e.problem_id = p.id
  WHERE e.type = 'evidence.created' AND e.object_kind = 'evidence'
    AND e.object_version = 1 AND e.seq > ?3 AND e.seq <= p.cursor
    AND p.cursor <= p.public_seq
  ORDER BY e.seq, e.id LIMIT ${RESEARCH_LIST_PAGE_SIZE + 1}
), numbered AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY seq, id) AS ordinal FROM admissions
), sources AS (
  SELECT e.id AS event_id, e.problem_id, e.object_id AS evidence_id, e.seq,
    e.created_at, e.payload_sha256, e.actor_fellow_id AS fellow_id,
    e.actor_sponsor_id AS sponsor_id, e.actor_session_id AS session_id,
    e.model_string_self_declared AS model_self_declared, e.harness AS harness_self_declared,
    CASE WHEN e.ordinal <= ${RESEARCH_LIST_PAGE_SIZE}
      AND length(CAST(screening.provenance_json AS BLOB)) <= 16384
      THEN screening.provenance_json END AS screening_provenance,
    CASE WHEN e.ordinal <= ${RESEARCH_LIST_PAGE_SIZE}
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND ${SOURCE_BYTES}
      AND NOT ${eventContentHiddenSql("e")}
      AND NOT EXISTS (SELECT 1 FROM events duplicate
        WHERE duplicate.problem_id = e.problem_id AND duplicate.object_id = e.object_id
          AND duplicate.type = 'evidence.created' AND duplicate.object_kind = 'evidence'
          AND duplicate.object_version = 1 AND duplicate.id <> e.id
          AND duplicate.seq <= (SELECT cursor FROM cut) LIMIT 1)
      THEN c.payload_json END AS source_json,
    EXISTS (SELECT 1 FROM scientific_withdrawals w JOIN events we
      ON we.id = w.event_id AND we.problem_id = w.problem_id AND we.seq = w.seq
      AND we.payload_sha256 = w.event_sha256 AND we.type = 'object.retracted'
      AND we.object_kind = 'retraction' AND we.object_version = 1
      AND we.object_id = w.retraction_id
      WHERE w.problem_id = e.problem_id AND w.target_kind = 'evidence'
        AND w.target_object = e.object_id AND w.source_event_id = e.id
        AND w.source_sha256 = e.payload_sha256
        AND we.seq > e.seq AND we.seq <= (SELECT cursor FROM cut)) AS withdrawn
  FROM numbered e LEFT JOIN event_content c ON c.event_id = e.id
  LEFT JOIN screening_publications screening ON screening.event_id = e.id
), pins AS (
  SELECT *,
    json_extract(CASE WHEN json_valid(source_json) THEN source_json ELSE '{}' END, '$.bears_on_kind') AS target_kind,
    json_extract(CASE WHEN json_valid(source_json) THEN source_json ELSE '{}' END, '$.bears_on_id') AS target_id,
    json_extract(CASE WHEN json_valid(source_json) THEN source_json ELSE '{}' END, '$.bears_on_version') AS target_version
  FROM sources
), targets AS (
  SELECT source.*, target.id AS target_event_id, target.seq AS target_seq,
    target.object_version AS target_object_version, target.payload_sha256 AS target_sha256,
    CASE WHEN tc.payload_sha256 = target.payload_sha256 AND tc.redacted_at IS NULL
      AND length(CAST(tc.payload_json AS BLOB)) BETWEEN 1 AND ${SOURCE_BYTES}
      AND NOT ${eventContentHiddenSql("target")}
      AND NOT EXISTS (SELECT 1 FROM events duplicate
        WHERE duplicate.problem_id = target.problem_id
          AND duplicate.object_kind = target.object_kind
          AND duplicate.object_id = target.object_id
          AND duplicate.object_version = target.object_version
          AND duplicate.type IN ('claim.created', 'claim.revised', 'hypothesis.created')
          AND duplicate.id <> target.id AND duplicate.seq <= (SELECT cursor FROM cut) LIMIT 1)
      THEN tc.payload_json END AS target_json
  FROM pins source LEFT JOIN events target ON target.id = (
    SELECT parent.id FROM events parent WHERE parent.problem_id = source.problem_id
      AND parent.object_id = source.target_id AND parent.object_kind = source.target_kind
      AND parent.seq < source.seq
      AND ((source.target_kind = 'claim' AND parent.object_version = source.target_version
        AND ((source.target_version = 1 AND parent.type = 'claim.created')
          OR (source.target_version > 1 AND parent.type = 'claim.revised')))
        OR (source.target_kind = 'hypothesis' AND parent.type = 'hypothesis.created'
          AND parent.object_version = 1 AND source.target_version IS NULL))
    ORDER BY parent.seq LIMIT 1
  ) LEFT JOIN event_content tc ON tc.event_id = target.id
), budgeted AS (
  SELECT *, SUM(COALESCE(length(CAST(source_json AS BLOB)), 0)
    + COALESCE(length(CAST(target_json AS BLOB)), 0)) OVER (ORDER BY seq, event_id) AS payload_bytes
  FROM targets
)
SELECT event_id, problem_id, evidence_id, seq, created_at, payload_sha256,
  fellow_id, sponsor_id, session_id, model_self_declared, harness_self_declared,
  screening_provenance, withdrawn, target_kind, target_id, target_version,
  target_event_id, target_seq, target_object_version, target_sha256,
  CASE WHEN payload_bytes <= ${PAGE_BYTES} THEN source_json END AS payload_json,
  CASE WHEN payload_bytes <= ${PAGE_BYTES} THEN target_json END AS target_json
FROM budgeted ORDER BY seq, event_id`;

interface Head {
  id: string;
  public_seq: number;
  cursor: number;
  unlisted: number;
}
interface Source {
  event_id: string;
  problem_id: string;
  evidence_id: string;
  seq: number;
  created_at: string;
  payload_sha256: string;
  payload_json: string | null;
  fellow_id: string | null;
  sponsor_id: string | null;
  session_id: string | null;
  model_self_declared: string | null;
  harness_self_declared: string | null;
  screening_provenance: string | null;
  withdrawn: number;
  target_kind: unknown;
  target_id: unknown;
  target_version: unknown;
  target_event_id: string | null;
  target_seq: number | null;
  target_object_version: number | null;
  target_sha256: string | null;
  target_json: string | null;
}

const sequence = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

async function snapshot(db: D1Database, problem: string, through: number | null, after: number) {
  const results = await db.batch([
    db.prepare(HEAD_SQL).bind(through, problem),
    db.prepare(PAGE_SQL).bind(through, problem, after),
  ]);
  if (results.length !== 2 || results.some((result) => !result.success))
    throw new EvidenceListReadError("unavailable");
  const heads = results[0]?.results;
  const rows = results[1]?.results as unknown as Source[];
  if (!Array.isArray(heads) || !Array.isArray(rows) || heads.length > 1)
    throw new EvidenceListReadError("unavailable");
  const head = heads[0] as Head | undefined;
  if (!head) throw new EvidenceListReadError("not-found");
  if (
    head.id !== problem ||
    !sequence(head.public_seq) ||
    !sequence(head.cursor) ||
    ![0, 1].includes(head.unlisted) ||
    rows.length > RESEARCH_LIST_PAGE_SIZE + 1
  )
    throw new EvidenceListReadError("unavailable");
  if (head.cursor > head.public_seq || after > head.cursor)
    throw new EvidenceListReadError("query");
  let previous = after;
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      row.problem_id !== problem ||
      !sequence(row.seq, 1) ||
      row.seq <= previous ||
      row.seq > head.cursor ||
      ids.has(row.event_id)
    )
      throw new EvidenceListReadError("unavailable");
    ids.add(row.event_id);
    previous = row.seq;
  }
  return { head, rows };
}

function requestPayload(payload: Record<string, unknown>) {
  const candidate = { ...payload };
  for (const key of ["computed_class", "coercion_flags", "caused_by", "sponsor_promotion"])
    delete candidate[key];
  for (const key of [
    "bears_on_version",
    "computation_domain_or_floor",
    "reproduction",
    "selected_hypothesis_id",
    "falsification_check",
    "formal_artifact",
  ])
    if (candidate[key] === null) delete candidate[key];
  return EvidenceRequestSchema.safeParse(candidate);
}

async function readableTarget(row: Source): Promise<boolean> {
  if (
    row.target_json === null ||
    row.target_sha256 === null ||
    !sequence(row.target_seq, 1) ||
    row.target_seq >= row.seq
  )
    return false;
  const target = await checkedScientificPayload({
    payload_json: row.target_json,
    payload_sha256: row.target_sha256,
  });
  if (row.target_kind === "claim")
    return (
      ClaimIdSchema.safeParse(row.target_id).success &&
      sequence(row.target_version, 1) &&
      row.target_object_version === row.target_version &&
      target.claim_id === row.target_id &&
      ClaimKindSchema.safeParse(target.kind).success &&
      typeof target.statement === "string" &&
      target.statement.length > 0 &&
      (row.target_version === 1 || target.base_version === row.target_version - 1)
    );
  if (row.target_kind !== "hypothesis" || row.target_object_version !== 1) return false;
  const candidate = { ...target };
  for (const key of ["sponsor_promotion", "caused_by"]) delete candidate[key];
  if (candidate.expected_evidence === null) delete candidate.expected_evidence;
  return HypothesisRequestSchema.safeParse(candidate).success;
}

/** A navigable publication history, not a second evidence grader. Source
 * fields are decoded with the write contract and exact target bytes are hash
 * checked. The directory never infers present supporting authority, stale
 * standing, independent reproduction or proof from an authored direction. */
export async function loadEvidenceList(
  db: D1Database,
  problem: string,
  query: ResearchListQuery = {},
): Promise<{
  face: EvidenceListResponse;
  unlisted: boolean;
  assertCurrent(): Promise<void>;
}> {
  const after = query.after ?? 0;
  if (
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !sequence(after) ||
    (query.after !== undefined && query.through === undefined) ||
    (query.through !== undefined && (!sequence(query.through) || after > query.through))
  )
    throw new EvidenceListReadError("query");
  const { head, rows } = await snapshot(db, problem, query.through ?? null, after);
  const evidence: EvidenceListResponse["evidence"] = [];
  const omitted = new Set<EvidenceListResponse["omitted"][number]>();
  const admitted = rows.slice(0, RESEARCH_LIST_PAGE_SIZE);
  for (const row of admitted) {
    try {
      if (row.payload_json === null || !(await readableTarget(row)))
        throw new ScientificInputError("Unavailable evidence publication or target.");
      const payload = await checkedScientificPayload({ ...row, payload_json: row.payload_json });
      const decoded = requestPayload(payload);
      if (
        !decoded.success ||
        decoded.data.bears_on_kind !== row.target_kind ||
        decoded.data.bears_on_id !== row.target_id ||
        (decoded.data.bears_on_kind === "claim" &&
          decoded.data.bears_on_version !== row.target_version) ||
        (row.withdrawn !== 0 && row.withdrawn !== 1)
      )
        throw new ScientificInputError("The evidence identity could not be verified.");
      const data = decoded.data;
      const notice = publicationScreeningNotice(row.screening_provenance);
      const entry = EvidenceListEntrySchema.safeParse({
        evidence_id: row.evidence_id,
        publication: {
          event_id: row.event_id,
          seq: row.seq,
          created_at: row.created_at,
          payload_sha256: row.payload_sha256,
          fellow_id: row.fellow_id,
          sponsor_id: row.sponsor_id,
          session_id: row.session_id,
          model_self_declared: row.model_self_declared,
          harness_self_declared: row.harness_self_declared,
        },
        bears_on:
          data.bears_on_kind === "claim"
            ? { kind: "claim", id: data.bears_on_id, version: data.bears_on_version }
            : { kind: "hypothesis", id: data.bears_on_id },
        direction: data.direction,
        kind: data.kind,
        mode: data.mode,
        withdrawn: row.withdrawn === 1,
        read_url: `/p/${encodeURIComponent(problem)}/evidence/${encodeURIComponent(row.evidence_id)}.json`,
        ...(notice === undefined ? {} : { screening_notice: notice }),
      });
      if (!entry.success) throw new ScientificInputError("Invalid publication metadata.");
      evidence.push(entry.data);
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.add("content_unavailable");
    }
  }
  const scanned = admitted.at(-1)?.seq ?? after;
  const next = rows.length > RESEARCH_LIST_PAGE_SIZE ? scanned : null;
  if (next !== null) omitted.add("page_limit");
  const face = EvidenceListResponseSchema.parse({
    schema: RESEARCH_LISTS_SCHEMA_ID,
    problem_id: problem,
    cursor: head.cursor,
    after,
    scanned_through: scanned,
    next_after: next,
    count: evidence.length,
    evidence,
    omitted: [...omitted],
  });
  const original = JSON.stringify(rows);
  return {
    face,
    unlisted: head.unlisted === 1,
    async assertCurrent() {
      // Later appends do not invalidate a frozen page, but hiding, redaction,
      // unlisting or source damage during async decoding must prevent release.
      const current = await snapshot(db, problem, head.cursor, after);
      if (current.head.unlisted !== head.unlisted || JSON.stringify(current.rows) !== original)
        throw new EvidenceListReadError("unavailable");
    },
  };
}
