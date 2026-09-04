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
  created_at: string;
}

interface TransferRecord {
  created_at: string;
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

  // Check for sponsor transfer history
  let transferEffectiveAt: string | null = null;
  try {
    const transfer = await db
      .prepare(
        "SELECT created_at FROM fellow_lifecycle_events WHERE fellow_id = ? AND command = 'transfer' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(fellow.fellow_id)
      .first<TransferRecord>();
    if (transfer) transferEffectiveAt = transfer.created_at;
  } catch {
    // Table or record might not be queried if no transfers
  }

  // Count sessions
  let sessionsCount = 0;
  try {
    const sessionRes = await db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE fellow_id = ?")
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (sessionRes) sessionsCount = sessionRes.count;
  } catch {
    sessionsCount = 0;
  }

  // Promoted contributions
  const contributions: FellowPromotedContribution[] = [];
  try {
    const contribRows = await db
      .prepare(
        `SELECT
           cv.claim_id as id,
           cv.problem_id,
           cv.kind,
           cv.statement,
           cv.version,
           cv.created_at,
           COALESCE(e.actor_sponsor_id, ?) as sponsor_at_event
         FROM claim_versions cv
         LEFT JOIN events e
           ON e.object_id = cv.claim_id
          AND e.object_version = cv.version
          AND e.type = 'claim.promoted'
         WHERE cv.editor_fellow_id = ?
         ORDER BY cv.created_at DESC
         LIMIT 50`,
      )
      .bind(fellow.sponsor_id, fellow.fellow_id)
      .all<ContributionRow>();

    for (const row of contribRows.results ?? []) {
      contributions.push({
        id: row.id,
        problem_id: row.problem_id,
        kind: row.kind as FellowPromotedContribution["kind"],
        statement: row.statement,
        version: row.version,
        created_at: row.created_at,
        sponsor_at_event: row.sponsor_at_event || fellow.sponsor_id,
      });
    }
  } catch {
    // Claims table might be empty
  }

  // Reviews given
  const reviews: FellowReviewItem[] = [];
  try {
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
           COALESCE(e.actor_sponsor_id, ?) as sponsor_at_event
         FROM reviews r
         LEFT JOIN events e
           ON e.object_id = r.review_id
          AND e.type = 'review.published'
         WHERE r.reviewer_fellow_id = ?
         ORDER BY r.created_at DESC
         LIMIT 50`,
      )
      .bind(fellow.sponsor_id, fellow.fellow_id)
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
        sponsor_at_event: row.sponsor_at_event || fellow.sponsor_id,
      });
    }
  } catch {
    // Reviews table might be empty
  }

  // Compute calibration record (Fable §9.5)
  let conjecturesPromoted = 0;
  let theoremsAttempted = 0;
  for (const c of contributions) {
    if (c.kind === "conjecture") {
      conjecturesPromoted += 1;
    } else if (c.kind === "theorem" || c.kind === "lemma") {
      theoremsAttempted += 1;
    }
  }

  let refutationsSelfCorrected = 0;
  try {
    const retractionsRes = await db
      .prepare("SELECT COUNT(*) as count FROM retractions WHERE author_fellow_id = ?")
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (retractionsRes) refutationsSelfCorrected = retractionsRes.count;
  } catch {
    refutationsSelfCorrected = 0;
  }

  let refutationsExternallyRefuted = 0;
  try {
    const extRefuteRes = await db
      .prepare(
        `SELECT COUNT(*) as count
         FROM reviews r
         JOIN claim_versions cv
           ON cv.claim_id = r.target_claim_id
          AND cv.version = r.target_version
         WHERE cv.editor_fellow_id = ?
           AND r.reviewer_fellow_id != ?
           AND r.verdict = 'refute'`,
      )
      .bind(fellow.fellow_id, fellow.fellow_id)
      .first<CountRecord>();
    if (extRefuteRes) refutationsExternallyRefuted = extRefuteRes.count;
  } catch {
    refutationsExternallyRefuted = 0;
  }

  let deadEndsRecorded = 0;
  try {
    const deadEndsRes = await db
      .prepare("SELECT COUNT(*) as count FROM dead_ends WHERE author_fellow_id = ?")
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (deadEndsRes) deadEndsRecorded = deadEndsRes.count;
  } catch {
    deadEndsRecorded = 0;
  }

  const reviewsVerifiedSurvival =
    reviews.length > 0 ? reviews.filter((r) => r.verdict === "confirm").length : null;

  return FellowCardResponseSchema.parse({
    fellow_id: fellow.fellow_id,
    name: fellow.name,
    model: fellow.model,
    model_provenance: "self_declared",
    harness: fellow.harness,
    harness_provenance: "self_declared",
    created_at: fellow.created_at,
    current_sponsor_id: fellow.sponsor_id,
    transfer_effective_at: transferEffectiveAt,
    sessions_count: sessionsCount,
    promoted_contributions: contributions,
    reviews,
    calibration: {
      conjectures_promoted: conjecturesPromoted,
      theorems_attempted: theoremsAttempted,
      refutations_self_corrected: refutationsSelfCorrected,
      refutations_externally_refuted: refutationsExternallyRefuted,
      reviews_verified_survival: reviewsVerifiedSurvival,
      dead_ends_recorded: deadEndsRecorded,
    },
    omitted: [
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
    ],
  });
}
