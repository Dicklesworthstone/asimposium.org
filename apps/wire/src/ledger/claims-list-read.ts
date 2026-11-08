import { ClaimKindSchema, PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  CLAIMS_LIST_PAGE_SIZE,
  CLAIMS_LIST_SCHEMA_ID,
  type ClaimListEntry,
  type ClaimsListQuery,
  type ClaimsListResponse,
  ClaimsListResponseSchema,
} from "@asimposium/contracts/claims-list";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import { checkedScientificPayload, ScientificInputError } from "./scientific-checks.ts";
import { readPremiseAwareDisposition } from "./scientific-dependencies.ts";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificRow,
} from "./scientific-disposition.ts";

export class ClaimsListReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`CLAIMS_LIST_${code}`);
  }
}

interface Head {
  id: string;
  public_seq: number;
  unlisted: number;
}
interface Admission {
  id: string;
  source_seq: number;
  version: number;
  event_id: string;
}
interface Source extends Admission {
  payload_sha256: string;
  payload_json: string | null;
  created_at: string;
  screening_provenance: string | null;
}

// A collection must not turn eight summaries into unbounded scientific reads.
// Lookahead proves truncation; an incomplete assessment is never partially
// folded and presented as a fresh statement.
const SCIENTIFIC_READ_BUDGET = {
  maxRows: 128,
  maxPayloadBytes: 16 * 1024,
  maxTotalPayloadBytes: 128 * 1024,
};

const HEAD_SQL = `SELECT id, public_seq, unlisted FROM problems WHERE id = ?
  AND status <> 'private-draft' AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;

/** Latest immutable publications, not today's mutable claim projections.
 * Sequence is unique within a problem, so a single integer continuation is
 * sufficient even after revisions. A ninth envelope proves more work exists;
 * no source body or scientific fold is loaded for that lookahead. */
const ADMISSIONS_SQL = `WITH heads AS (
  SELECT object_id AS id, MAX(seq) AS source_seq FROM events
  WHERE problem_id = ? AND seq <= ? AND object_kind = 'claim'
    AND type IN ('claim.created', 'claim.revised')
  GROUP BY object_id
)
SELECT h.id, h.source_seq, e.object_version AS version, e.id AS event_id
FROM heads h JOIN events e ON e.problem_id = ? AND e.seq = h.source_seq
  AND e.object_id = h.id AND e.object_kind = 'claim'
  AND e.type IN ('claim.created', 'claim.revised')
WHERE h.source_seq > ? ORDER BY h.source_seq ASC, h.id ASC LIMIT ${CLAIMS_LIST_PAGE_SIZE + 1}`;

function checkedHead(value: Head | null | undefined, problem: string): Head {
  if (!value) throw new ClaimsListReadError("not-found");
  if (
    value.id !== problem ||
    !Number.isSafeInteger(value.public_seq) ||
    value.public_seq < 0 ||
    ![0, 1].includes(value.unlisted)
  )
    throw new ClaimsListReadError("unavailable");
  return value;
}

/** Page summaries reuse the exact claim reader's scientific fold and premise
 * health. The body, current privacy and raw scientific inputs are read in one
 * D1 batch; a stored claim projection cannot substitute for a missing source.
 * Membership, sessions, workshop bodies and private sponsor data never enter
 * the selection. Withheld admissions still advance the bounded continuation. */
export async function loadClaimsList(
  db: D1Database,
  problem: string,
  query: ClaimsListQuery = {},
): Promise<{ face: ClaimsListResponse; unlisted: boolean }> {
  if (!PublicLedgerProblemIdSchema.safeParse(problem).success)
    throw new ClaimsListReadError("not-found");
  const head = checkedHead(await db.prepare(HEAD_SQL).bind(problem).first<Head>(), problem);
  const cursor = query.through ?? head.public_seq;
  const after = query.after ?? 0;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > head.public_seq ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    after > cursor
  )
    throw new ClaimsListReadError("query");
  const selection = await db
    .prepare(ADMISSIONS_SQL)
    .bind(problem, cursor, problem, after)
    .all<Admission>();
  if (!selection.success || selection.results.length > CLAIMS_LIST_PAGE_SIZE + 1)
    throw new ClaimsListReadError("unavailable");
  let previous = after;
  const ids = new Set<string>();
  for (const row of selection.results) {
    if (
      !/^C-[0-9]+$(?![\s\S])/.test(row.id) ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.source_seq) ||
      row.source_seq <= previous ||
      row.source_seq > cursor ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.event_id !== "string"
    )
      throw new ClaimsListReadError("unavailable");
    ids.add(row.id);
    previous = row.source_seq;
  }
  const admitted = selection.results.slice(0, CLAIMS_LIST_PAGE_SIZE);
  const sourceStatement = db
    .prepare(`SELECT e.object_id AS id, e.seq AS source_seq,
    e.object_version AS version, e.id AS event_id, e.payload_sha256, e.created_at,
    CASE WHEN p.status <> 'private-draft' AND p.public_seq >= ? AND e.seq <= ?
      AND c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
      AND length(CAST(c.payload_json AS BLOB)) <= 524288 THEN c.payload_json END AS payload_json,
    s.provenance_json AS screening_provenance
    FROM events e JOIN problems p ON p.id = e.problem_id
    LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    LEFT JOIN screening_publications s ON s.event_id = e.id
    WHERE e.problem_id = ? AND e.id IN (SELECT value FROM json_each(?))
    ORDER BY e.seq ASC`)
    .bind(cursor, cursor, problem, JSON.stringify(admitted.map((row) => row.event_id)));
  const snapshot = await db.batch([
    db.prepare(HEAD_SQL).bind(problem),
    sourceStatement,
    ...admitted.map((row) =>
      prepareScientificDispositions(
        db,
        problem,
        cursor,
        1,
        { claimId: row.id, version: row.version },
        SCIENTIFIC_READ_BUDGET,
      ),
    ),
  ]);
  if (snapshot.length !== admitted.length + 2 || snapshot.some((result) => !result.success))
    throw new ClaimsListReadError("unavailable");
  const current = checkedHead(snapshot[0]?.results[0] as Head | undefined, problem);
  if (current.public_seq < cursor) throw new ClaimsListReadError("unavailable");
  const sources = snapshot[1]?.results as unknown as Source[];
  if (!Array.isArray(sources) || sources.length !== admitted.length)
    throw new ClaimsListReadError("unavailable");
  const claims: ClaimListEntry[] = [];
  const omitted = new Set<ClaimsListResponse["omitted"][number]>();
  for (const [index, row] of sources.entries()) {
    const admission = admitted[index];
    if (
      !admission ||
      row.event_id !== admission.event_id ||
      row.id !== admission.id ||
      row.version !== admission.version ||
      row.source_seq !== admission.source_seq
    )
      throw new ClaimsListReadError("unavailable");
    if (row.payload_json === null) {
      omitted.add("content_unavailable");
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await checkedScientificPayload({
        payload_json: row.payload_json,
        payload_sha256: row.payload_sha256,
      });
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.add("content_unavailable");
      continue;
    }
    const kind = ClaimKindSchema.safeParse(payload.kind);
    if (
      !kind.success ||
      payload.claim_id !== row.id ||
      typeof payload.statement !== "string" ||
      payload.statement.length < 1 ||
      payload.statement.length > 8192 ||
      (row.version > 1 && payload.base_version !== row.version - 1)
    ) {
      omitted.add("content_unavailable");
      continue;
    }
    const history = snapshot[index + 2]?.results as unknown as ScientificRow[];
    if (!Array.isArray(history)) throw new ClaimsListReadError("unavailable");
    if (
      history.length > SCIENTIFIC_READ_BUDGET.maxRows ||
      history.some((entry) => entry.scientific_budget_exceeded !== 0)
    ) {
      omitted.add("standing_unavailable");
      continue;
    }
    const science = history.filter((entry) => entry.target_version <= row.version);
    let fold = await foldScientificRows(science);
    if (fold.currentVersion !== row.version) {
      omitted.add("standing_unavailable");
      continue;
    }
    fold = await readPremiseAwareDisposition(db, problem, cursor, row.id, science, fold);
    const notice = publicationScreeningNotice(row.screening_provenance);
    const created = new Date(row.created_at);
    if (!Number.isFinite(created.getTime())) throw new ClaimsListReadError("unavailable");
    claims.push({
      id: row.id,
      version: row.version,
      kind: kind.data,
      statement: payload.statement,
      source_seq: row.source_seq,
      created_at: created.toISOString(),
      stale: fold.stale,
      ...(notice === undefined ? {} : { screening_notice: notice }),
    });
  }
  const scanned = admitted.at(-1)?.source_seq ?? after;
  const next = selection.results.length > CLAIMS_LIST_PAGE_SIZE ? scanned : null;
  if (next !== null) omitted.add("page_limit");
  return {
    face: ClaimsListResponseSchema.parse({
      schema: CLAIMS_LIST_SCHEMA_ID,
      problem_id: problem,
      cursor,
      after,
      scanned_through: scanned,
      next_after: next,
      count: claims.length,
      claims,
      omitted: [...omitted],
    }),
    unlisted: current.unlisted === 1,
  };
}
