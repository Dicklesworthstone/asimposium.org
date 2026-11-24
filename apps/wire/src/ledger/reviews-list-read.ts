import {
  ClaimKindSchema,
  PublicLedgerProblemIdSchema,
  ReviewRequestSchema,
} from "@asimposium/contracts";
import {
  RESEARCH_LIST_PAGE_SIZE,
  RESEARCH_LISTS_SCHEMA_ID,
  type ResearchListQuery,
  ResearchPublicationSchema,
  type ReviewListEntry,
  type ReviewListResponse,
  ReviewListResponseSchema,
} from "@asimposium/contracts/research-lists";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import {
  checkedScientificPayload,
  recordedReviewIndependence,
  ScientificInputError,
} from "./scientific-checks.ts";

export class ReviewsListReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`REVIEWS_LIST_${code}`);
  }
}

export const REVIEWS_LIST_SOURCE_BYTES = 512 * 1024;
export const REVIEWS_LIST_PAGE_BYTES = 1024 * 1024;
const TIER_NUMBER = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;

interface Head {
  id: string;
  public_seq: number;
  unlisted: number;
  cursor: number;
}
interface Source {
  event_id: string;
  problem_id: string;
  review_id: string;
  seq: number;
  object_version: number;
  admissions: number;
  created_at: string;
  payload_sha256: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  screening_provenance_json: string | null;
  withdrawn: number;
  budget_deferred: number;
  target_id: string | null;
  target_version: number | null;
  target_seq: number | null;
  target_sponsor_id: string | null;
  target_admissions: number;
  target_sha256: string | null;
  payload_json: string | null;
  target_json: string | null;
}

const CUT = `WITH cut AS (
  SELECT p.id, p.public_seq, p.unlisted, COALESCE(?, p.public_seq) AS cursor
  FROM problems p WHERE p.id = ? AND p.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
)`;
const HEAD_SQL = `${CUT} SELECT * FROM cut`;

// Select immutable admissions before applying current visibility. Withheld
// records still consume their slot, so even an entirely hidden page advances.
// Neither membership nor mutable review projections supply public attribution.
const ROWS_SQL = `${CUT}, page AS (
  SELECT e.id AS event_id, e.problem_id, e.object_id AS review_id, e.object_version,
    e.seq, e.created_at, e.payload_sha256, e.actor_fellow_id, e.actor_sponsor_id,
    e.actor_session_id, e.model_string_self_declared, e.harness,
    CASE WHEN length(CAST(screening.provenance_json AS BLOB)) <= 16384
      THEN screening.provenance_json END AS screening_provenance_json,
    (SELECT COUNT(*) FROM (SELECT 1 FROM events admitted
      WHERE admitted.problem_id = e.problem_id AND admitted.object_id = e.object_id
        AND admitted.object_kind = 'review' AND admitted.type = 'review.created'
        AND admitted.seq <= p.cursor LIMIT 2)) AS admissions,
    CASE WHEN c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
      AND NOT ${eventContentHiddenSql("e")} THEN 1 ELSE 0 END AS visible,
    length(CAST(c.payload_json AS BLOB)) AS payload_bytes, c.payload_json,
    json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
      '$.target_claim_id') AS requested_claim,
    json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
      '$.target_version') AS requested_version,
    EXISTS (SELECT 1 FROM scientific_withdrawals w JOIN events we
      ON we.id = w.event_id AND we.problem_id = w.problem_id AND we.seq = w.seq
      AND we.payload_sha256 = w.event_sha256 AND we.type = 'object.retracted'
      AND we.object_kind = 'retraction' AND we.object_id = w.retraction_id
      AND we.object_version = 1 AND we.seq > e.seq
      WHERE w.problem_id = p.id AND w.target_kind = 'review'
        AND w.target_object = e.object_id AND w.source_event_id = e.id
        AND w.source_sha256 = e.payload_sha256 AND we.seq <= p.cursor) AS withdrawn
  FROM cut p JOIN events e ON e.problem_id = p.id AND e.seq <= p.cursor
    AND e.seq > ? AND e.type = 'review.created' AND e.object_kind = 'review'
  LEFT JOIN event_content c ON c.event_id = e.id
  LEFT JOIN screening_publications screening ON screening.event_id = e.id
  ORDER BY e.seq, e.id LIMIT ${RESEARCH_LIST_PAGE_SIZE + 1}
), targets AS (
  SELECT page.*, t.object_id AS target_id, t.object_version AS target_version,
    t.seq AS target_seq, t.actor_sponsor_id AS target_sponsor_id,
    t.payload_sha256 AS target_sha256,
    (SELECT COUNT(*) FROM (SELECT 1 FROM events ce WHERE ce.problem_id = page.problem_id
      AND ce.object_id = page.requested_claim AND ce.object_version = page.requested_version
      AND ce.object_kind = 'claim' AND ce.type IN ('claim.created', 'claim.revised')
      AND ce.seq < page.seq LIMIT 2)) AS target_admissions,
    CASE WHEN tc.redacted_at IS NULL AND tc.payload_sha256 = t.payload_sha256
      AND NOT ${eventContentHiddenSql("t")} THEN 1 ELSE 0 END AS target_visible,
    length(CAST(tc.payload_json AS BLOB)) AS target_bytes, tc.payload_json AS target_json
  FROM page LEFT JOIN events t ON t.id = (
    SELECT ce.id FROM events ce WHERE ce.problem_id = page.problem_id
      AND ce.object_id = page.requested_claim AND ce.object_version = page.requested_version
      AND ce.object_kind = 'claim' AND ce.seq < page.seq
      AND ((ce.object_version = 1 AND ce.type = 'claim.created')
        OR (ce.object_version > 1 AND ce.type = 'claim.revised'))
    ORDER BY ce.seq LIMIT 1
  ) LEFT JOIN event_content tc ON tc.event_id = t.id
), budgeted AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY seq, event_id) AS ordinal,
    SUM(CASE WHEN visible = 1 AND target_visible = 1
      AND payload_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
      AND target_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
      THEN payload_bytes + target_bytes ELSE 0 END)
      OVER (ORDER BY seq, event_id) AS cumulative_bytes
  FROM targets
)
SELECT event_id, problem_id, review_id, seq, object_version, admissions, created_at,
  payload_sha256, actor_fellow_id, actor_sponsor_id, actor_session_id,
  model_string_self_declared, harness, screening_provenance_json, withdrawn,
  target_id, target_version, target_seq, target_sponsor_id, target_admissions, target_sha256,
  CASE WHEN ordinal <= ${RESEARCH_LIST_PAGE_SIZE} AND visible = 1 AND target_visible = 1
    AND payload_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND target_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND cumulative_bytes > ${REVIEWS_LIST_PAGE_BYTES} THEN 1 ELSE 0 END AS budget_deferred,
  CASE WHEN ordinal <= ${RESEARCH_LIST_PAGE_SIZE} AND visible = 1 AND target_visible = 1
    AND payload_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND target_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND cumulative_bytes <= ${REVIEWS_LIST_PAGE_BYTES} THEN payload_json END AS payload_json,
  CASE WHEN ordinal <= ${RESEARCH_LIST_PAGE_SIZE} AND visible = 1 AND target_visible = 1
    AND payload_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND target_bytes BETWEEN 1 AND ${REVIEWS_LIST_SOURCE_BYTES}
    AND cumulative_bytes <= ${REVIEWS_LIST_PAGE_BYTES} THEN target_json END AS target_json
FROM budgeted ORDER BY seq, event_id`;

function safeSequence(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function checkedHead(head: Head | undefined, problem: string): Head {
  if (!head) throw new ReviewsListReadError("not-found");
  if (
    head.id !== problem ||
    !safeSequence(head.public_seq) ||
    !safeSequence(head.cursor) ||
    ![0, 1].includes(head.unlisted)
  )
    throw new ReviewsListReadError("unavailable");
  return head;
}

async function checkedPayload(raw: string | null, hash: string | null) {
  if (raw === null || hash === null) return null;
  try {
    return await checkedScientificPayload({ payload_json: raw, payload_sha256: hash });
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    return null;
  }
}

/** Completed publications, including withdrawals and historical claim versions.
 * This is discovery, not another scientific fold: only recorded independence is
 * exposed; exact item/claim readers retain authority for scientific standing. */
export async function loadReviewsList(
  db: D1Database,
  problem: string,
  query: ResearchListQuery = {},
): Promise<{ face: ReviewListResponse; unlisted: boolean; assertCurrent(): Promise<void> }> {
  if (!PublicLedgerProblemIdSchema.safeParse(problem).success)
    throw new ReviewsListReadError("not-found");
  const after = query.after ?? 0;
  if (
    !safeSequence(after) ||
    (query.through !== undefined && !safeSequence(query.through)) ||
    (query.after !== undefined && (query.through === undefined || after > query.through))
  )
    throw new ReviewsListReadError("query");
  const snapshot = async (through: number | null) => {
    const result = await db.batch([
      db.prepare(HEAD_SQL).bind(through, problem),
      db.prepare(ROWS_SQL).bind(through, problem, after),
    ]);
    if (
      result.length !== 2 ||
      result.some((part) => !part.success || !Array.isArray(part.results)) ||
      result[0]?.results.length !== 1
    ) {
      if (result[0]?.success && result[0].results.length === 0)
        throw new ReviewsListReadError("not-found");
      throw new ReviewsListReadError("unavailable");
    }
    const head = checkedHead(result[0]?.results[0] as unknown as Head, problem);
    if (head.cursor > head.public_seq || after > head.cursor)
      throw new ReviewsListReadError("query");
    const rows = result[1]?.results as unknown as Source[];
    if (rows.length > RESEARCH_LIST_PAGE_SIZE + 1) throw new ReviewsListReadError("unavailable");
    return { head, rows };
  };
  const { head, rows } = await snapshot(query.through ?? null);
  let scanned = after;
  const reviews: ReviewListEntry[] = [];
  const omitted = new Set<ReviewListResponse["omitted"][number]>();
  let budgetDeferred = false;
  for (const row of rows.slice(0, RESEARCH_LIST_PAGE_SIZE)) {
    if (
      row.problem_id !== problem ||
      !safeSequence(row.seq, 1) ||
      row.seq <= scanned ||
      row.seq > head.cursor ||
      ![0, 1].includes(row.withdrawn) ||
      ![0, 1].includes(row.budget_deferred)
    )
      throw new ReviewsListReadError("unavailable");
    if (row.budget_deferred === 1) {
      // Leave the first deferred publication for the next request. Each source
      // and parent is at most half the page budget, so it fits on a fresh page.
      if (scanned === after) throw new ReviewsListReadError("unavailable");
      budgetDeferred = true;
      break;
    }
    scanned = row.seq;
    const [payload, target] = await Promise.all([
      checkedPayload(row.payload_json, row.payload_sha256),
      checkedPayload(row.target_json, row.target_sha256),
    ]);
    const publication = ResearchPublicationSchema.safeParse({
      event_id: row.event_id,
      seq: row.seq,
      created_at: row.created_at,
      payload_sha256: row.payload_sha256,
      fellow_id: row.actor_fellow_id,
      sponsor_id: row.actor_sponsor_id,
      session_id: row.actor_session_id,
      model_self_declared: row.model_string_self_declared,
      harness_self_declared: row.harness,
    });
    // Stored publication payloads include computed tier/policy and nullable
    // optional fields. Validate the authored request through its shared schema.
    const authored = ReviewRequestSchema.safeParse(
      payload === null
        ? null
        : Object.fromEntries(
            Object.keys(ReviewRequestSchema.shape)
              .filter((key) => payload[key] !== undefined && payload[key] !== null)
              .map((key) => [key, payload[key]]),
          ),
    );
    if (
      !publication.success ||
      !authored.success ||
      payload === null ||
      target === null ||
      row.object_version !== 1 ||
      row.admissions !== 1 ||
      row.target_admissions !== 1 ||
      !/^R-[0-9A-HJKMNP-TV-Z]{1,78}$(?![\s\S])/.test(row.review_id) ||
      authored.data.target_claim_id !== row.target_id ||
      authored.data.target_version !== row.target_version ||
      !safeSequence(row.target_version, 1) ||
      !safeSequence(row.target_seq, 1) ||
      row.target_seq >= row.seq ||
      target.claim_id !== row.target_id ||
      !ClaimKindSchema.safeParse(target.kind).success ||
      typeof target.statement !== "string" ||
      target.statement.length < 1 ||
      target.statement.length > 8192 ||
      (row.target_version > 1 && target.base_version !== row.target_version - 1)
    ) {
      omitted.add("content_unavailable");
      continue;
    }
    const independence =
      row.target_sponsor_id === null || row.actor_sponsor_id === null
        ? null
        : recordedReviewIndependence(payload, row.target_sponsor_id, row.actor_sponsor_id);
    const screeningNotice = publicationScreeningNotice(row.screening_provenance_json);
    reviews.push({
      review_id: row.review_id,
      publication: publication.data,
      target: { claim_id: authored.data.target_claim_id, version: authored.data.target_version },
      verdict: authored.data.verdict,
      basis: authored.data.basis,
      independence_tier:
        independence === null || independence.legacy ? null : TIER_NUMBER[independence.tier],
      withdrawn: row.withdrawn === 1,
      read_url: `/p/${encodeURIComponent(problem)}/reviews/${row.review_id}.json`,
      ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
    });
  }
  const next = budgetDeferred || rows.length > RESEARCH_LIST_PAGE_SIZE ? scanned : null;
  if (next !== null) omitted.add("page_limit");
  const face = ReviewListResponseSchema.parse({
    schema: RESEARCH_LISTS_SCHEMA_ID,
    problem_id: problem,
    cursor: head.cursor,
    after,
    scanned_through: scanned,
    next_after: next,
    count: reviews.length,
    reviews,
    omitted: [...omitted],
  });
  const captured = JSON.stringify(rows);
  return {
    face,
    unlisted: head.unlisted === 1,
    async assertCurrent() {
      // Hashing/rendering yields to other requests. Recheck the same public cut
      // immediately before delivery, including conditional and HEAD replies.
      const current = await snapshot(head.cursor);
      if (current.head.unlisted !== head.unlisted || JSON.stringify(current.rows) !== captured)
        throw new ReviewsListReadError("unavailable");
    },
  };
}
