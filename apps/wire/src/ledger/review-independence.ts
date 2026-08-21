/**
 * W5.7 review independence tiers. Independent review is the only status-moving
 * force, so its independence is graded and inspectable, never boolean. The tier
 * is computed from the IMMUTABLE attribution recorded on the authored and review
 * events (sponsor, declared model family, method basis) — never the Fellow's
 * CURRENT sponsor binding, so a later transfer cannot manufacture, upgrade,
 * demote, or erase historical independence.
 *
 *   T0 — same sponsor (a sponsor reviewing their own Fellow's work)
 *   T1 — different sponsor
 *   T2 — different sponsor AND a different declared model family
 *   T3 — T2 AND a disjoint method basis
 *
 * strongly-supported requires >= T2 (Fable §6.4). A looks-right review is
 * accepted but tagged basis:assertion-only and moves nothing.
 */

export interface ReviewAttribution {
  readonly sponsorId: string;
  readonly modelFamily: string;
  readonly methodBasis: string;
}

export type IndependenceTier = "T0" | "T1" | "T2" | "T3";

/**
 * P1 first: the author can never review their own object. The caller checks
 * `reviewerIsAuthor` before consulting the tier.
 */
export function reviewerIsAuthor(authorFellowId: string, reviewerFellowId: string): boolean {
  return authorFellowId === reviewerFellowId;
}

/**
 * The independence tier of a review, from the two immutable attribution records.
 * Pure — the same two records always compute the same tier, and a later sponsor
 * transfer cannot change a historical review's tier.
 */
export function independenceTier(
  author: ReviewAttribution,
  reviewer: ReviewAttribution,
): IndependenceTier {
  if (author.sponsorId === reviewer.sponsorId) return "T0";
  if (author.modelFamily === reviewer.modelFamily) return "T1";
  if (author.methodBasis === reviewer.methodBasis) return "T2";
  return "T3";
}

/** strongly-supported requires a review at T2 or higher (Fable §6.4). */
export function tierMovesDisclosure(tier: IndependenceTier): boolean {
  return tier === "T2" || tier === "T3";
}
