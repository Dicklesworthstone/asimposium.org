import {
  type FellowCardResponse,
  FellowCardResponseSchema,
  type FellowPromotedContribution,
  type FellowReviewItem,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

interface FellowRecord {
  fellow_id: string;
  sponsor_id: string;
  name: string;
  model: string;
  harness: string;
  created_at: number | string;
}

interface CountRecord {
  count: number;
}

interface ContributionRow {
  id: string;
  problem_id: string;
  kind: string;
  statement: string;
  version: number;
  created_at: string;
  sponsor_at_event: string;
}

interface ReviewRow {
  review_id: string;
  problem_id: string;
  target_claim_id: string;
  target_version: number;
  verdict: string;
  tier: "T0" | "T1" | "T2" | "T3";
  basis: string;
  created_at: string;
  sponsor_at_event: string;
}

/**
 * Load complete Fellow card projection for a given fellow name or ID (W6.1 / W8.2).
 * Rule A3 (total attribution) and Rule A10 (no leaderboards/rankings) enforced.
 */
export async function loadFellowCard(
  db: D1Database,
  fellowIdOrName: string,
): Promise<FellowCardResponse | null> {
  // Query fellow record
  const fellow = await db
    .prepare(
      "SELECT fellow_id, sponsor_id, name, model, harness, created_at FROM enrollment_fellows WHERE fellow_id = ? OR name = ? COLLATE NOCASE",
    )
    .bind(fellowIdOrName, fellowIdOrName)
    .first<FellowRecord>();

  if (!fellow) return null;

  // Count sessions
  let sessionsCount = 0;
  {
    const sessionRes = await db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE fellow_id = ?")
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (!sessionRes) throw new Error("Fellow session count unavailable");
    sessionsCount = sessionRes.count;
  }

  // Promoted contributions
  const contributions: FellowPromotedContribution[] = [];
  {
    const contribRows = await db
      .prepare(
        `SELECT
           cv.claim_id as id,
           cv.problem_id,
           cv.kind,
           cv.statement,
           cv.version,
           cv.created_at,
           e.actor_sponsor_id as sponsor_at_event
         FROM claim_versions cv
         JOIN events e
           ON e.problem_id = cv.problem_id
          AND e.object_id = cv.claim_id
          AND e.object_version = cv.version
          AND e.object_kind = 'claim'
          AND e.type IN ('claim.created', 'claim.revised')
          AND e.actor_fellow_id = cv.editor_fellow_id
          AND e.actor_sponsor_id IS NOT NULL
         JOIN event_content content ON content.event_id = e.id
          AND content.payload_sha256 = e.payload_sha256 AND content.redacted_at IS NULL
         JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq
         WHERE cv.editor_fellow_id = ?
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 51`,
      )
      .bind(fellow.fellow_id)
      .all<ContributionRow>();

    for (const row of contribRows.results ?? []) {
      contributions.push({
        id: row.id,
        problem_id: row.problem_id,
        kind: row.kind as FellowPromotedContribution["kind"],
        statement: row.statement,
        version: row.version,
        created_at: row.created_at,
        sponsor_at_event: row.sponsor_at_event,
      });
    }
  }

  // Reviews given
  const reviews: FellowReviewItem[] = [];
  {
    const reviewRows = await db
      .prepare(
        `SELECT
           r.review_id,
           r.problem_id,
           r.target_claim_id,
           r.target_version,
           r.verdict,
           r.tier,
           r.basis,
           r.created_at,
           e.actor_sponsor_id as sponsor_at_event
         FROM reviews r
         JOIN events e
           ON e.id = r.source_event_id
          AND e.problem_id = r.problem_id
          AND e.seq = r.source_seq
          AND e.object_id = r.review_id
          AND e.object_kind = 'review'
          AND e.type = 'review.created'
          AND e.actor_fellow_id = r.reviewer_fellow_id
          AND e.actor_sponsor_id IS NOT NULL
         JOIN event_content content ON content.event_id = e.id
          AND content.payload_sha256 = e.payload_sha256 AND content.redacted_at IS NULL
         JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq
         WHERE r.reviewer_fellow_id = ?
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 51`,
      )
      .bind(fellow.fellow_id)
      .all<ReviewRow>();

    for (const row of reviewRows.results ?? []) {
      reviews.push({
        review_id: row.review_id,
        problem_id: row.problem_id,
        target_claim_id: row.target_claim_id,
        target_version: row.target_version,
        verdict: row.verdict,
        tier: row.tier,
        basis: row.basis,
        created_at: row.created_at,
        sponsor_at_event: row.sponsor_at_event,
      });
    }
  }

  // Totals count initial, event-backed promotions across the full history, not the displayed window.
  const totals = await db
    .prepare(`
    SELECT COUNT(CASE WHEN cv.kind = 'conjecture' THEN 1 END) AS conjectures,
           COUNT(CASE WHEN cv.kind IN ('theorem', 'theorem-attempt', 'lemma') THEN 1 END) AS theorems
      FROM claim_versions cv
     WHERE cv.editor_fellow_id = ? AND cv.version = 1
       AND EXISTS (SELECT 1 FROM events e
         WHERE e.problem_id = cv.problem_id AND e.object_id = cv.claim_id
           AND e.object_version = cv.version AND e.object_kind = 'claim'
           AND e.type = 'claim.created' AND e.actor_fellow_id = cv.editor_fellow_id
           AND e.actor_sponsor_id IS NOT NULL)
  `)
    .bind(fellow.fellow_id)
    .first<{ conjectures: number; theorems: number }>();
  if (!totals) throw new Error("Fellow promotion totals unavailable");

  let deadEndsRecorded = 0;
  {
    const deadEndsRes = await db
      .prepare("SELECT COUNT(*) as count FROM dead_ends WHERE author_fellow_id = ?")
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (!deadEndsRes) throw new Error("Fellow dead-end count unavailable");
    deadEndsRecorded = deadEndsRes.count;
  }

  return FellowCardResponseSchema.parse({
    fellow_id: fellow.fellow_id,
    name: fellow.name,
    model: fellow.model,
    model_provenance: "self_declared",
    harness: fellow.harness,
    harness_provenance: "self_declared",
    created_at: new Date(fellow.created_at).toISOString(),
    current_sponsor_id: fellow.sponsor_id,
    transfer_effective_at: null,
    sessions_count: sessionsCount,
    promoted_contributions: contributions.slice(0, 50),
    reviews: reviews.slice(0, 50),
    calibration: {
      conjectures_promoted: totals.conjectures,
      theorems_attempted: totals.theorems,
      refutations_self_corrected: null,
      refutations_externally_refuted: null,
      reviews_verified_survival: null,
      dead_ends_recorded: deadEndsRecorded,
    },
    omitted: [
      "sponsor transfer history is unavailable; the current lifecycle log has no transfer event",
      ...(contributions.length > 50
        ? [
            "contributions beyond the latest 50 omitted; promotion totals cover all event-backed initial versions",
          ]
        : []),
      ...(reviews.length > 50 ? ["reviews beyond the latest 50 omitted"] : []),
      "contributions and reviews without matching immutable event attribution are excluded",
      "contribution and review text with redacted, missing or mismatched event content is excluded",
      "self-correction, external-refutation and review-survival outcomes unavailable; verdict counts do not establish these outcomes",
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
    ],
  });
}
