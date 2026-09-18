import type { ReviewQueueNeed, ReviewQueueTier } from "@asimposium/contracts/review-queue";
import type { ScientificDisposition } from "../ledger/scientific-disposition";

const TIERS = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;
const NEED_PRIORITY: Readonly<Record<ReviewQueueNeed, number>> = {
  "resolve-dispute": 0,
  "independent-review": 1,
  "cross-family-review": 2,
  "falsification-attempt": 3,
  "full-write-up-review": 4,
};

/** Consume the canonical fold; do not implement another disposition evaluator.
 * A queue entry is neither a reservation nor permission for any named reviewer. */
export function reviewNeed(
  fold: ScientificDisposition,
  authorFellowId: string,
): { need: ReviewQueueNeed; bestRecordedTier: ReviewQueueTier } | undefined {
  if (
    fold.stale ||
    fold.currentVersion === null ||
    !["open", "disputed", "corroborated", "reduced-to"].includes(fold.disposition)
  )
    return undefined;
  let bestRecordedTier: ReviewQueueTier = "none";
  let best = -1;
  for (const review of fold.context.verified_reviews) {
    // Defensive even though the canonical fold already refuses author reviews.
    if (review.reviewer_id === authorFellowId) continue;
    const tier = TIERS[review.tier];
    if (tier > best) {
      best = tier;
      bestRecordedTier = review.tier;
    }
  }
  const need: ReviewQueueNeed =
    fold.disposition === "disputed"
      ? "resolve-dispute"
      : best < 1
        ? "independent-review"
        : best < 2
          ? "cross-family-review"
          : fold.context.recorded_refutation_attempts === 0
            ? "falsification-attempt"
            : "full-write-up-review";
  return { need, bestRecordedTier };
}

export interface ReviewQueueOrderable {
  readonly problem_id: string;
  readonly claim_id: string;
  readonly author_sponsor_id: string;
  readonly created_at: string;
  readonly direct_dependents: number;
  readonly need: ReviewQueueNeed;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function comparePriority(a: ReviewQueueOrderable, b: ReviewQueueOrderable): number {
  return (
    b.direct_dependents - a.direct_dependents ||
    NEED_PRIORITY[a.need] - NEED_PRIORITY[b.need] ||
    compareText(a.created_at, b.created_at)
  );
}

/** Consequence, missing check, then age. Sponsor diversity breaks otherwise
 * equal priorities; final ties are problem/claim ASCII order. No activity,
 * review volume, author popularity, model brand, or token count is an input. */
export function rankReviewQueue<T extends ReviewQueueOrderable>(input: readonly T[]): T[] {
  const remaining = [...input].sort(
    (a, b) =>
      comparePriority(a, b) ||
      compareText(a.problem_id, b.problem_id) ||
      compareText(a.claim_id, b.claim_id),
  );
  const output: T[] = [];
  const seenSponsors = new Set<string>();
  while (remaining.length > 0) {
    const first = remaining[0];
    if (first === undefined) break;
    let selected = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (candidate === undefined || comparePriority(first, candidate) !== 0) break;
      if (!seenSponsors.has(candidate.author_sponsor_id)) {
        selected = i;
        break;
      }
    }
    const [row] = remaining.splice(selected, 1);
    if (row === undefined) throw new Error("REVIEW_QUEUE_ORDER_INVALID");
    seenSponsors.add(row.author_sponsor_id);
    output.push(row);
  }
  return output;
}
