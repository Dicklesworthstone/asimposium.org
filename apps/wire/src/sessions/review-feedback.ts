import {
  REVIEW_FEEDBACK_OMISSION_REASONS,
  REVIEW_FEEDBACK_SAMPLE_LIMIT,
  type ReviewFeedback,
  ReviewFeedbackSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";

interface ObservationRow {
  through_seq: number;
  publication_seq: number | null;
  published_at: string | null;
  visible: number;
  first_review_at: string | null;
  excluded_review: number;
}

function utcMillis(value: string | null): number | undefined {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const normalized = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  return new Date(milliseconds).toISOString() === normalized ? milliseconds : undefined;
}

/** Pure arithmetic over bounded metadata; no body, author, model or tier leaves
 * the query. The first readable review is selected BEFORE checking its clock. */
export function summarizeReviewFeedback(rows: readonly ObservationRow[]): ReviewFeedback | null {
  const cut = rows[0]?.through_seq;
  if (cut === undefined) return null;
  const durations: number[] = [];
  const omitted = new Set<ReviewFeedback["omitted"][number]>();
  let unreviewed = 0;
  let unmeasurable = 0;
  if (rows.length > REVIEW_FEEDBACK_SAMPLE_LIMIT) omitted.add("sample_limit");
  for (const row of rows.slice(0, REVIEW_FEEDBACK_SAMPLE_LIMIT)) {
    if (row.through_seq !== cut) throw new Error("inconsistent review feedback cut");
    if (row.publication_seq === null) continue;
    if (row.visible !== 1) {
      omitted.add("content_unavailable");
      continue;
    }
    if (row.excluded_review === 1) omitted.add("content_unavailable");
    if (row.first_review_at === null) {
      unreviewed++;
      continue;
    }
    const published = utcMillis(row.published_at);
    const reviewed = utcMillis(row.first_review_at);
    if (published === undefined || reviewed === undefined || reviewed < published) {
      unmeasurable++;
      omitted.add("invalid_timestamp");
      continue;
    }
    durations.push((reviewed - published) / 1000);
  }
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median =
    durations.length === 0
      ? null
      : durations
          .slice(Math.floor((durations.length - 1) / 2), middle + 1)
          .reduce((sum, seconds) => sum + seconds, 0) / (durations.length % 2 ? 1 : 2);
  return ReviewFeedbackSchema.parse({
    basis: "first-readable-non-author-review-on-version",
    through_seq: cut,
    sample_limit: REVIEW_FEEDBACK_SAMPLE_LIMIT,
    sampled_versions: durations.length + unreviewed + unmeasurable,
    reviewed_versions: durations.length,
    unreviewed_versions: unreviewed,
    unmeasurable_versions: unmeasurable,
    median_first_review_seconds: median,
    omitted: REVIEW_FEEDBACK_OMISSION_REASONS.filter((reason) => omitted.has(reason)),
  });
}

/** A single D1 read captures an ACTUAL persisted public cut. Receipt builders
 * may run before their write commits; predicted sequence/atomic-batch overlays
 * are deliberately not passed off as observed history. Bound raw candidates
 * before current visibility checks; omissions do not cause a refill scan. */
export async function readProblemReviewFeedback(
  db: D1Database,
  problemId: string,
): Promise<ReviewFeedback | null> {
  try {
    const result = await db
      .prepare(`WITH scope AS (
      SELECT id, public_seq FROM problems p WHERE id = ? AND status <> 'private-draft'
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
    ), candidates AS (
      SELECT e.id, e.problem_id, e.object_id, e.object_version, e.seq, e.payload_sha256, e.created_at
      FROM events e JOIN scope p ON p.id = e.problem_id
      WHERE e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
        AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT ${REVIEW_FEEDBACK_SAMPLE_LIMIT + 1}
    )
    SELECT p.public_seq AS through_seq, pub.seq AS publication_seq, pub.created_at AS published_at,
      CASE WHEN EXISTS (SELECT 1 FROM event_content c
        WHERE c.event_id = pub.id AND c.payload_sha256 = pub.payload_sha256 AND c.redacted_at IS NULL)
        AND NOT ${eventContentHiddenSql("pub")} THEN 1 ELSE 0 END AS visible,
      (SELECT re.created_at FROM reviews r JOIN events re ON re.id = r.source_event_id
        AND re.problem_id = r.problem_id AND re.object_id = r.review_id
        AND re.object_kind = 'review' AND re.type = 'review.created'
        AND re.actor_fellow_id = r.reviewer_fellow_id
        JOIN event_content rc ON rc.event_id = re.id AND rc.payload_sha256 = re.payload_sha256
          AND rc.redacted_at IS NULL
        JOIN events author ON author.problem_id = pub.problem_id AND author.object_id = pub.object_id
          AND author.type = 'claim.created' AND author.object_kind = 'claim' AND author.object_version = 1
        WHERE r.problem_id = pub.problem_id AND r.target_claim_id = pub.object_id
          AND r.target_version = pub.object_version AND re.actor_fellow_id <> author.actor_fellow_id
          AND re.seq > pub.seq AND re.seq <= p.public_seq
          AND NOT ${eventContentHiddenSql("re")}
        ORDER BY re.seq ASC LIMIT 1) AS first_review_at,
      EXISTS (SELECT 1 FROM reviews r JOIN events re ON re.id = r.source_event_id
        AND re.problem_id = r.problem_id AND re.object_id = r.review_id
        AND re.object_kind = 'review' AND re.type = 'review.created'
        AND re.actor_fellow_id = r.reviewer_fellow_id
        JOIN events author ON author.problem_id = pub.problem_id AND author.object_id = pub.object_id
          AND author.type = 'claim.created' AND author.object_kind = 'claim' AND author.object_version = 1
        WHERE r.problem_id = pub.problem_id AND r.target_claim_id = pub.object_id
          AND r.target_version = pub.object_version AND re.actor_fellow_id <> author.actor_fellow_id
          AND re.seq > pub.seq AND re.seq <= p.public_seq
          AND (NOT EXISTS (SELECT 1 FROM event_content rc WHERE rc.event_id = re.id
            AND rc.payload_sha256 = re.payload_sha256 AND rc.redacted_at IS NULL)
            OR ${eventContentHiddenSql("re")})) AS excluded_review
    FROM scope p LEFT JOIN candidates pub ON pub.problem_id = p.id ORDER BY pub.seq DESC`)
      .bind(problemId)
      .all<ObservationRow>();
    if (!result.success) return null;
    return summarizeReviewFeedback(result.results);
  } catch {
    // An optional observation must not block publication or invent a zero wait.
    // Null also covers scopes without public observation; replay never rereads.
    return null;
  }
}
