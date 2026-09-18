import {
  encodeNowPageCursor,
  type FellowCardQuery,
  FellowCardQuerySchema,
  type FellowCardResponse,
  FellowCardResponseSchema,
  type FellowPromotedContribution,
  FellowPromotedContributionSchema,
  type FellowReviewItem,
  FellowReviewItemSchema,
  parseNowPageCursor,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  checkedScientificPayload,
  recordedReviewIndependence,
  ScientificInputError,
} from "../ledger/scientific-checks";

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
  event_id: string;
  seq: number;
  id: string;
  problem_id: string;
  kind: string;
  payload_json: string;
  payload_sha256: string;
  version: number;
  created_at: string;
  sponsor_at_event: string;
}

interface ReviewRow {
  event_id: string;
  seq: number;
  review_id: string;
  problem_id: string;
  target_claim_id: string;
  target_version: number;
  payload_json: string;
  payload_sha256: string;
  author_sponsor_at_event: string;
  created_at: string;
  sponsor_at_event: string;
}

/**
 * Load a bounded Fellow card page for a given fellow name or ID (W6.1 / W8.2).
 * Rule A3 (total attribution) and Rule A10 (no leaderboards/rankings) enforced.
 */
export async function loadFellowCard(
  db: D1Database,
  fellowIdOrName: string,
  query: FellowCardQuery = {},
): Promise<FellowCardResponse | null> {
  const parsed = FellowCardQuerySchema.parse(query);
  const contributionsBoundary = parseNowPageCursor(parsed.contributions_before);
  const reviewsBoundary = parseNowPageCursor(parsed.reviews_before);
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
      .prepare(`SELECT COUNT(*) as count FROM sessions s JOIN problems p ON p.id = s.problem_id
        WHERE s.fellow_id = ? AND p.status != 'private-draft' AND p.unlisted = 0`)
      .bind(fellow.fellow_id)
      .first<CountRecord>();
    if (!sessionRes) throw new Error("Fellow session count unavailable");
    sessionsCount = sessionRes.count;
  }

  // Promoted contributions
  const contributions: FellowPromotedContribution[] = [];
  let nextContributions: string | undefined;
  let unavailableContributions = 0;
  {
    const contribRows = await db
      .prepare(
        `SELECT
           e.id as event_id,
           e.seq,
           cv.claim_id as id,
           cv.problem_id,
           cv.kind,
           content.payload_json,
           e.payload_sha256,
           cv.version,
           e.created_at,
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
         WHERE cv.editor_fellow_id = ?1 AND p.status != 'private-draft' AND p.unlisted = 0
         ${contributionsBoundary === undefined ? "" : HISTORY_BEFORE}
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 51`,
      )
      .bind(fellow.fellow_id, ...(contributionsBoundary?.slice(1) ?? []))
      .all<ContributionRow>();

    if (contribRows.results.length > 50) {
      // Advance past the last examined row even if its body cannot be served.
      const last = contribRows.results[49];
      if (last === undefined) throw new Error("Fellow contribution boundary unavailable");
      nextContributions = encodeNowPageCursor(last);
    }
    for (const row of contribRows.results.slice(0, 50)) {
      const payload = await availablePayload(row);
      const item = FellowPromotedContributionSchema.safeParse({
        id: row.id,
        problem_id: row.problem_id,
        kind: row.kind as FellowPromotedContribution["kind"],
        statement: payload?.statement,
        version: row.version,
        created_at: row.created_at,
        sponsor_at_event: row.sponsor_at_event,
      });
      if (payload?.claim_id === row.id && item.success) contributions.push(item.data);
      else unavailableContributions++;
    }
  }

  // Reviews given
  const reviews: FellowReviewItem[] = [];
  let nextReviews: string | undefined;
  let unavailableReviews = 0;
  let legacyReviews = 0;
  {
    const reviewRows = await db
      .prepare(
        `SELECT
           e.id as event_id,
           e.seq,
           r.review_id,
           r.problem_id,
           r.target_claim_id,
           r.target_version,
           content.payload_json,
           e.payload_sha256,
           author.actor_sponsor_id as author_sponsor_at_event,
           e.created_at,
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
         JOIN events author
           ON author.problem_id = r.problem_id
          AND author.object_id = r.target_claim_id
          AND author.object_version = r.target_version
          AND author.object_kind = 'claim'
          AND author.type IN ('claim.created', 'claim.revised')
          AND author.seq < e.seq
          AND author.actor_sponsor_id IS NOT NULL
         WHERE r.reviewer_fellow_id = ?1 AND p.status != 'private-draft' AND p.unlisted = 0
         ${reviewsBoundary === undefined ? "" : HISTORY_BEFORE}
         ORDER BY e.created_at DESC, e.problem_id ASC, e.seq DESC, e.id ASC
         LIMIT 51`,
      )
      .bind(fellow.fellow_id, ...(reviewsBoundary?.slice(1) ?? []))
      .all<ReviewRow>();

    if (reviewRows.results.length > 50) {
      const last = reviewRows.results[49];
      if (last === undefined) throw new Error("Fellow review boundary unavailable");
      nextReviews = encodeNowPageCursor(last);
    }
    for (const row of reviewRows.results.slice(0, 50)) {
      const payload = await availablePayload(row);
      if (
        !payload ||
        payload.target_claim_id !== row.target_claim_id ||
        payload.target_version !== row.target_version
      ) {
        unavailableReviews++;
        continue;
      }
      const { tier, legacy } = recordedReviewIndependence(
        payload,
        row.author_sponsor_at_event,
        row.sponsor_at_event,
      );
      const item = FellowReviewItemSchema.safeParse({
        review_id: row.review_id,
        problem_id: row.problem_id,
        target_claim_id: row.target_claim_id,
        target_version: row.target_version,
        verdict: payload.verdict,
        tier,
        basis: payload.basis,
        created_at: row.created_at,
        sponsor_at_event: row.sponsor_at_event,
      });
      if (item.success) {
        reviews.push(item.data);
        if (legacy) legacyReviews++;
      } else unavailableReviews++;
    }
  }

  // Totals count initial, event-backed promotions across the full history, not the displayed window.
  const totals = await db
    .prepare(`
    SELECT COUNT(CASE WHEN cv.kind = 'conjecture' THEN 1 END) AS conjectures,
           COUNT(CASE WHEN cv.kind IN ('theorem', 'theorem-attempt', 'lemma') THEN 1 END) AS theorems
      FROM claim_versions cv
      JOIN problems p ON p.id = cv.problem_id AND p.status != 'private-draft' AND p.unlisted = 0
     WHERE cv.editor_fellow_id = ? AND cv.version = 1
       AND EXISTS (SELECT 1 FROM events e
         WHERE e.problem_id = cv.problem_id AND e.object_id = cv.claim_id
           AND e.object_version = cv.version AND e.object_kind = 'claim'
           AND e.type = 'claim.created' AND e.actor_fellow_id = cv.editor_fellow_id
           AND e.actor_sponsor_id IS NOT NULL AND e.seq <= p.public_seq)
  `)
    .bind(fellow.fellow_id)
    .first<{ conjectures: number; theorems: number }>();
  if (!totals) throw new Error("Fellow promotion totals unavailable");

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
    promoted_contributions: contributions,
    reviews,
    ...(nextContributions === undefined ? {} : { next_contributions_before: nextContributions }),
    ...(nextReviews === undefined ? {} : { next_reviews_before: nextReviews }),
    calibration: {
      conjectures_promoted: totals.conjectures,
      theorems_attempted: totals.theorems,
      refutations_self_corrected: null,
      refutations_externally_refuted: null,
      reviews_verified_survival: null,
    },
    omitted: [
      "private and unlisted problems are excluded from contribution and review lists and all activity counts",
      "sponsor transfer history is unavailable; the current lifecycle log has no transfer event",
      "history pages examine at most 50 records per list; promotion totals cover all event-backed initial versions",
      "history is a live traversal, not a snapshot; new events and visibility changes can affect later reads",
      ...(nextContributions !== undefined
        ? ["older contributions are available through next_contributions_before"]
        : []),
      ...(nextReviews !== undefined
        ? ["older reviews are available through next_reviews_before"]
        : []),
      ...(unavailableContributions > 0
        ? [
            `${unavailableContributions} contribution records on this page failed ledger content verification`,
          ]
        : []),
      ...(unavailableReviews > 0
        ? [
            `${unavailableReviews} review records on this page failed ledger content or version-pin verification`,
          ]
        : []),
      ...(legacyReviews > 0
        ? [
            `${legacyReviews} legacy reviews lack current independence provenance; tiers are limited to T0/T1 using sponsors at the exact reviewed version`,
          ]
        : []),
      "contributions and reviews without matching immutable event attribution are excluded",
      "contribution and review text with redacted, missing or mismatched event content is excluded",
      "review tiers describe publication provenance, not subsequent evidence availability or verification survival",
      "self-correction, external-refutation and review-survival outcomes unavailable; verdict counts do not establish these outcomes",
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
    ],
  });
}

// Parameter 1 is the Fellow; the remaining parameters mirror the full ORDER BY.
const HISTORY_BEFORE = `AND (
  e.created_at < ?2 OR (e.created_at = ?2 AND (
    e.problem_id > ?3 OR (e.problem_id = ?3 AND (
      e.seq < ?4 OR (e.seq = ?4 AND e.id > ?5)
    ))
  ))
)`;

async function availablePayload(row: {
  payload_json: string;
  payload_sha256: string;
}): Promise<Record<string, unknown> | null> {
  try {
    return await checkedScientificPayload(row);
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
}
