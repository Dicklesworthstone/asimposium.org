import type { D1Database } from "@cloudflare/workers-types";
import { ReviewRequestError } from "./model.ts";
import { hashText, type ContentPin } from "./store.ts";

export interface ReviewRequestTarget {
  cursor: number;
  claim_id: string;
  claim_version: number;
  author_id: string;
  author_sponsor_id: string;
  pin: ContentPin;
}
export const REVIEW_REQUEST_TARGET_SQL = `SELECT p.public_seq AS cursor, e.object_id AS claim_id,
  e.object_version AS claim_version, origin.actor_fellow_id AS author_id,
  e.actor_sponsor_id AS author_sponsor_id, e.id AS event_id, e.payload_sha256 AS digest,
  CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 32768 THEN c.payload_json END AS payload_json
  FROM problems p JOIN events e ON e.problem_id = p.id AND e.object_kind = 'claim'
    AND e.object_id = ? AND e.type IN ('claim.created','claim.revised')
    AND e.seq = (SELECT MAX(seq) FROM events WHERE problem_id = p.id AND object_id = e.object_id
      AND object_kind = 'claim' AND type IN ('claim.created','claim.revised') AND seq <= p.public_seq)
  JOIN events origin ON origin.problem_id = p.id AND origin.object_id = e.object_id
    AND origin.type = 'claim.created' AND origin.object_kind = 'claim' AND origin.object_version = 1
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
  WHERE p.id = ? AND p.unlisted = 0 AND p.status IN ('active','dormant','under-result-review')
    AND e.object_version = ? AND NOT EXISTS (
      SELECT 1 FROM retractions r JOIN events re ON re.problem_id = r.problem_id
        AND re.object_id = r.retraction_id AND re.seq = r.seq AND re.type = 'object.retracted'
        AND re.actor_fellow_id = origin.actor_fellow_id
      WHERE r.problem_id = p.id AND r.target_object IN (e.object_id, e.object_id || '@' || e.object_version)
        AND re.seq <= p.public_seq
    ) LIMIT 2`;
async function verifiedPayload(row: ContentPin): Promise<Record<string, unknown>> {
  if (typeof row.payload_json !== "string" || new TextEncoder().encode(row.payload_json).length > 32768 ||
      !/^[0-9a-f]{64}$/.test(row.digest) || await hashText(row.payload_json) !== row.digest) {
    throw new ReviewRequestError("INELIGIBLE");
  }
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { throw new ReviewRequestError("INELIGIBLE"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ReviewRequestError("INELIGIBLE");
  return payload as Record<string, unknown>;
}
/** Invitation readiness means a current readable exact statement, not an
 * affirmative scientific standing. Authors may request scrutiny of disputes. */
export async function readReviewRequestTarget(db: D1Database, problem: string, claim: string, version: number): Promise<ReviewRequestTarget> {
  const result = await db.prepare(REVIEW_REQUEST_TARGET_SQL).bind(claim, problem, version)
    .all<Omit<ReviewRequestTarget, "pin"> & ContentPin>();
  const row = result.results[0];
  if (result.results.length !== 1 || !row || !Number.isSafeInteger(row.cursor) || row.cursor < 1 ||
      row.claim_id !== claim || row.claim_version !== version || typeof row.author_id !== "string" ||
      typeof row.author_sponsor_id !== "string") throw new ReviewRequestError("INELIGIBLE");
  const pin = { event_id: row.event_id, digest: row.digest, payload_json: row.payload_json };
  const payload = await verifiedPayload(pin);
  if (payload.claim_id !== claim || typeof payload.statement !== "string" ||
      (version > 1 && payload.base_version !== version - 1)) throw new ReviewRequestError("INELIGIBLE");
  return { cursor: row.cursor, claim_id: claim, claim_version: version, author_id: row.author_id,
    author_sponsor_id: row.author_sponsor_id, pin };
}
export async function readCompletionReview(db: D1Database, problem: string, claim: string, version: number, reviewer: string, reviewId: string): Promise<ContentPin> {
  const result = await db.prepare(`SELECT e.id AS event_id, e.payload_sha256 AS digest,
    CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 32768 THEN c.payload_json END AS payload_json
    FROM reviews r JOIN events e ON e.id = r.source_event_id AND e.problem_id = r.problem_id
      AND e.object_id = r.review_id AND e.seq = r.source_seq AND e.type = 'review.created' AND e.object_kind = 'review'
    JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq AND p.status <> 'private-draft' AND p.unlisted = 0
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE r.problem_id = ? AND r.review_id = ? AND r.target_claim_id = ? AND r.target_version = ?
      AND r.reviewer_fellow_id = ? AND e.actor_fellow_id = ? LIMIT 2`)
    .bind(problem, reviewId, claim, version, reviewer, reviewer).all<ContentPin>();
  const row = result.results[0];
  if (result.results.length !== 1 || !row) throw new ReviewRequestError("INELIGIBLE");
  const payload = await verifiedPayload(row);
  if (payload.target_claim_id !== claim || payload.target_version !== version) throw new ReviewRequestError("INELIGIBLE");
  return row;
}
