import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewQueueScience } from "../discovery/review-queue-read.ts";
import type { RetryAdmission } from "./dead-end-retries.ts";
import type { ScientificRow } from "./scientific-disposition.ts";

export const RETRY_SCIENCE_MAX_EVENTS = 256;
export const RETRY_SCIENCE_MAX_BYTES = 1024 * 1024;
/** Count the same claim/review/evidence/retraction scope used by the canonical
 * evaluator before materializing bodies. Unrelated activity does not exhaust
 * this per-claim budget. A large history is unavailable, never partially folded. */
export const RETRY_SCIENCE_BUDGET_SQL = `WITH input AS (SELECT ? AS j), scope AS (
  SELECT e.id, e.payload_sha256 FROM input, events e
  LEFT JOIN reviews r ON r.source_event_id = e.id AND r.problem_id = e.problem_id
    AND r.review_id = e.object_id AND r.source_seq = e.seq AND e.type = 'review.created'
  LEFT JOIN evidence x ON x.source_event_id = e.id AND x.problem_id = e.problem_id
    AND x.evidence_id = e.object_id AND x.source_seq = e.seq
    AND x.bears_on_kind = 'claim' AND e.type = 'evidence.created'
  LEFT JOIN retractions ret ON ret.problem_id = e.problem_id AND ret.retraction_id = e.object_id
    AND ret.seq = e.seq AND ret.author_fellow_id = e.actor_fellow_id
    AND e.object_kind = 'retraction' AND e.type = 'object.retracted'
  WHERE e.problem_id = json_extract(j,'$.problem') AND e.seq <= json_extract(j,'$.through')
    AND e.type IN ('claim.created','claim.revised','review.created','evidence.created','object.retracted')
    AND json_extract(j,'$.claim') = CASE WHEN e.object_kind = 'claim' THEN e.object_id
      WHEN e.object_kind = 'review' THEN r.target_claim_id
      WHEN e.object_kind = 'retraction' THEN CASE WHEN instr(ret.target_object,'@') > 0
        THEN substr(ret.target_object,1,instr(ret.target_object,'@')-1) ELSE ret.target_object END
      ELSE x.bears_on_id END
  LIMIT ${RETRY_SCIENCE_MAX_EVENTS + 1}
) SELECT COUNT(*) AS events, COALESCE(SUM(length(CAST(c.payload_json AS BLOB))),0) AS bytes
FROM scope LEFT JOIN event_content c ON c.event_id = scope.id
  AND c.payload_sha256 = scope.payload_sha256 AND c.redacted_at IS NULL`;

/** A stored firing is a discovery hint, not proof of a transition. Recompute
 * before/after/current from the SAME bounded canonical timeline. Later loss of
 * support or a revised target suppresses the old recommendation. */
export async function verifyRetryClaimTransition(
  db: D1Database,
  row: RetryAdmission,
  claim: string,
  reaches: string,
  through: number,
  science: ReviewQueueScience,
): Promise<"holds" | "not-held" | "unavailable"> {
  const budget = await db
    .prepare(RETRY_SCIENCE_BUDGET_SQL)
    .bind(JSON.stringify({ problem: row.problem_id, claim, through }))
    .first<{ events: number; bytes: number }>();
  if (
    !budget ||
    !Number.isSafeInteger(budget.events) ||
    !Number.isSafeInteger(budget.bytes) ||
    budget.events < 1 ||
    budget.events > RETRY_SCIENCE_MAX_EVENTS ||
    budget.bytes < 0 ||
    budget.bytes > RETRY_SCIENCE_MAX_BYTES
  )
    return "unavailable";
  const rows = (
    await science
      .prepare(db, row.problem_id, through, 1, { claimId: claim, version: Number.MAX_SAFE_INTEGER })
      .all<ScientificRow>()
  ).results;
  if (
    !Array.isArray(rows) ||
    rows.length !== budget.events ||
    rows.length > RETRY_SCIENCE_MAX_EVENTS
  )
    return "unavailable";
  const firing = rows.find((event) => event.event_id === row.event_id);
  if (
    !firing ||
    firing.claim_id !== claim ||
    firing.seq !== row.seq ||
    firing.payload_sha256 !== row.payload_sha256 ||
    firing.payload_json !== row.payload_json ||
    !Number.isSafeInteger(firing.target_version) ||
    firing.target_version < 1
  )
    return "unavailable";
  if (rows.some((event) => event.claim_id !== claim || event.seq > through)) return "unavailable";
  const before = await science.fold(rows.filter((event) => event.seq < row.seq));
  const after = await science.fold(rows.filter((event) => event.seq <= row.seq));
  const current = through === row.seq ? after : await science.fold(rows);
  if (before.stale || after.stale || current.stale) return "unavailable";
  const pins = rows
    .filter((event) => event.payload_json !== null)
    .map((event) => ({
      event_id: event.event_id,
      digest: event.payload_sha256,
      body: event.payload_json,
    }));
  const available = await db
    .prepare(`SELECT COUNT(*) AS n FROM json_each(?) pin
    JOIN events e ON e.id = json_extract(pin.value,'$.event_id') AND e.problem_id = ?
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL AND c.payload_json = json_extract(pin.value,'$.body')
    WHERE e.payload_sha256 = json_extract(pin.value,'$.digest') AND e.seq <= ?`)
    .bind(JSON.stringify(pins), row.problem_id, through)
    .first<{ n: number }>();
  if (available?.n !== pins.length) return "unavailable";
  return before.disposition !== reaches &&
    after.disposition === reaches &&
    after.currentVersion === firing.target_version &&
    current.currentVersion === after.currentVersion &&
    current.disposition === reaches
    ? "holds"
    : "not-held";
}
