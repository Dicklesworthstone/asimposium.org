/**
 * W5.4 — the disposition state machine (Fable §6.4, ADR-9). This module is the
 * honesty core of the ledger: a disposition is an OUTPUT of evidence and review
 * events, computed here, never an author-set field (P2/P4). There is no `proved`
 * state anywhere; the strongest public phrasing is `strongly-supported`, and the
 * `machine-checked` marker is a display badge over it (ADR-10), not a
 * disposition.
 *
 * Everything here is pure: no D1, no routes, no clock. Callers hand the
 * evaluator the current disposition, one event, and a context describing the
 * ledger facts the transition rests on; the evaluator answers allowed/next or
 * refused with the EXACT unmet conditions (§6.4: "Transition evaluators always
 * return the exact unmet conditions"). A refusal never mutates anything.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const CLAIM_DISPOSITIONS = [
  "draft",
  "open",
  "malformed",
  "disputed",
  "corroborated",
  "strongly-supported",
  "refuted",
  "reduced-to",
  "withdrawn",
  "superseded",
] as const;
export type ClaimDisposition = (typeof CLAIM_DISPOSITIONS)[number];

export const HYPOTHESIS_DISPOSITIONS = [
  "active",
  "narrowed",
  "killed",
  "deferred",
  "superseded",
] as const;
export type HypothesisDisposition = (typeof HYPOTHESIS_DISPOSITIONS)[number];

export const REVIEW_STATE_FACETS = [
  "unreviewed",
  "review-requested",
  "under-review",
  "contested",
  "independently-checked",
] as const;
export type ReviewStateFacet = (typeof REVIEW_STATE_FACETS)[number];

/**
 * §6.6. T0 same sponsor · T1 different sponsor · T2 different sponsor +
 * different self-declared model family · T3 = T2 + disjoint method stated in
 * `basis`. A review's tier is computed and PINNED at review time; a later
 * sponsorship transfer, re-declaration, or roster change never retroactively
 * upgrades it.
 */
export const INDEPENDENCE_TIERS = ["T0", "T1", "T2", "T3"] as const;
export type IndependenceTier = (typeof INDEPENDENCE_TIERS)[number];

const TIER_RANK: Readonly<Record<IndependenceTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export function tierAtLeast(tier: IndependenceTier, floor: IndependenceTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[floor];
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type TransitionResult<NEXT extends string> =
  | { readonly allowed: true; readonly next: NEXT }
  | { readonly allowed: false; readonly unmet: readonly string[] };

function allow<NEXT extends string>(next: NEXT): TransitionResult<NEXT> {
  return { allowed: true, next };
}

function refuse<NEXT extends string>(...unmet: readonly string[]): TransitionResult<NEXT> {
  return { allowed: false, unmet };
}

// ---------------------------------------------------------------------------
// Claim events
// ---------------------------------------------------------------------------

/** A review whose independence was computed and pinned at review time (§6.6). */
export interface VerifiedReview {
  readonly review_id: string;
  readonly reviewer_id: string;
  readonly tier: IndependenceTier;
  /** Reviewer and author are of different self-declared model families. */
  readonly cross_family: boolean;
  /** The review covered a full write-up, not an excerpt or a summary. */
  readonly full_write_up: boolean;
  readonly finding: "support" | "dispute" | "statement-defect";
}

export type ClaimEvent =
  /** draft → open. Statement/falsifier completeness (P3) is enforced by the write schema. */
  | { readonly kind: "promote" }
  /** An independently verified review lands. Findings route: support corroborates, dispute opens a live contest, statement-defect routes to malformed. */
  | { readonly kind: "review-verified"; readonly review: VerifiedReview }
  /** A refutation attempt against the claim's falsifier was recorded. Refuter-first: corroboration is impossible without one. */
  | { readonly kind: "refutation-attempt-recorded"; readonly attempt_id: string }
  /** Refuting evidence lands against the claim, or already-standing refuting evidence is re-evaluated for settlement. */
  | {
      readonly kind: "evidence-refuted";
      readonly evidence_id: string;
      readonly confirmed_by_independent_review: boolean;
      readonly unanswered_hours: number;
    }
  /** The author concedes the refutation. Self-correction is recorded as refuted-by-concession. */
  | { readonly kind: "author-concession" }
  /** The author withdraws the claim outright. */
  | { readonly kind: "author-withdrawal" }
  /** Bookkeeping, not progress: the original stays open in needs and ranking until the target resolves (§6.4). */
  | { readonly kind: "reduced-to"; readonly target_claim_id: string }
  /** A new statement version mints @n+1; the old version is superseded. The ONLY exit from malformed. */
  | { readonly kind: "new-version"; readonly new_version: number }
  /** Operator repairs exist only for genuine platform defects and are themselves public ledger events; a reason is mandatory. There is no silent override. */
  | {
      readonly kind: "operator-repair";
      readonly reason: string;
      readonly to: ClaimDisposition;
    };

/**
 * Ledger facts a transition may rest on, current at evaluation time. For a
 * `review-verified` event the event's own review is considered IN ADDITION to
 * `verified_reviews`; the caller records history, the evaluator counts the
 * landing review itself.
 */
export interface ClaimTransitionContext {
  readonly recorded_refutation_attempts: number;
  readonly verified_reviews: readonly VerifiedReview[];
  /** A certified-class artifact (independent compilation + statement-equivalence review, §6.5) backs the claim. */
  readonly has_certified_artifact: boolean;
}

export const EMPTY_CLAIM_CONTEXT: ClaimTransitionContext = {
  recorded_refutation_attempts: 0,
  verified_reviews: [],
  has_certified_artifact: false,
};

// ---------------------------------------------------------------------------
// Claim transition evaluator
// ---------------------------------------------------------------------------

const LIVE_STATES: readonly ClaimDisposition[] = [
  "open",
  "disputed",
  "corroborated",
  "strongly-supported",
  "reduced-to",
];

const TERMINAL_STATES: readonly ClaimDisposition[] = ["refuted", "withdrawn", "superseded"];

function bestTier(reviews: readonly VerifiedReview[]): IndependenceTier | undefined {
  let best: IndependenceTier | undefined;
  for (const review of reviews) {
    if (best === undefined || TIER_RANK[review.tier] > TIER_RANK[best]) best = review.tier;
  }
  return best;
}

function sameVerifiedReview(left: VerifiedReview, right: VerifiedReview): boolean {
  return (
    left.review_id === right.review_id &&
    left.reviewer_id === right.reviewer_id &&
    left.tier === right.tier &&
    left.cross_family === right.cross_family &&
    left.full_write_up === right.full_write_up &&
    left.finding === right.finding
  );
}

/**
 * Only supporting reviews can be affirmative evidence for corroboration or
 * strong support. Identical replayed rows count once; conflicting rows with
 * the same review id count zero rather than letting storage corruption choose
 * whichever copy grants the stronger transition.
 */
export function distinctSupportingReviews(reviews: readonly VerifiedReview[]): VerifiedReview[] {
  const firstById = new Map<string, VerifiedReview>();
  const conflictedIds = new Set<string>();
  for (const review of reviews) {
    const first = firstById.get(review.review_id);
    if (first === undefined) {
      firstById.set(review.review_id, review);
    } else if (!sameVerifiedReview(first, review)) {
      conflictedIds.add(review.review_id);
    }
  }
  return [...firstById.values()].filter(
    (review) => review.finding === "support" && !conflictedIds.has(review.review_id),
  );
}

function corroborationUnmet(
  reviews: readonly VerifiedReview[],
  context: ClaimTransitionContext,
): string[] {
  const unmet: string[] = [];
  if (!distinctSupportingReviews(reviews).some((review) => tierAtLeast(review.tier, "T1"))) {
    unmet.push("requires ≥1 independent verified review (tier ≥ T1)");
  }
  if (context.recorded_refutation_attempts < 1) {
    unmet.push("requires ≥1 recorded refutation attempt");
  }
  return unmet;
}

function strongSupportUnmet(
  reviews: readonly VerifiedReview[],
  context: ClaimTransitionContext,
): string[] {
  const unmet: string[] = [];
  const supportingReviews = distinctSupportingReviews(reviews);
  // Independent corroboration is supplied by people/agents, not by rows: one
  // reviewer cannot satisfy the two-review leg by filing multiple review ids.
  // Furthermore, each cross-family review must itself be independent (tier ≥ T2).
  const crossFamilyFullWriteUpReviewers = new Set(
    supportingReviews
      .filter((review) => review.cross_family && review.full_write_up && tierAtLeast(review.tier, "T2"))
      .map((review) => review.reviewer_id),
  ).size;
  if (!context.has_certified_artifact && crossFamilyFullWriteUpReviewers < 2) {
    unmet.push(
      "requires a certified-class artifact or two cross-family verified reviews of a full write-up",
    );
  }
  const best = bestTier(supportingReviews);
  if (best === undefined || !tierAtLeast(best, "T2")) {
    unmet.push(`requires independence tier ≥ T2, got ${best ?? "none"}`);
  }
  return unmet;
}

function refutedUnmet(event: Extract<ClaimEvent, { kind: "evidence-refuted" }>): string[] {
  const unmet: string[] = [];
  if (!event.confirmed_by_independent_review) {
    unmet.push("requires the refuting evidence to be confirmed by an independent review");
  }
  if (event.unanswered_hours < 72) {
    unmet.push(
      `requires the refuting evidence to stand unanswered for 72h, got ${event.unanswered_hours}h`,
    );
  }
  return unmet;
}

export function evaluateClaimTransition(
  current: ClaimDisposition,
  event: ClaimEvent,
  context: ClaimTransitionContext,
): TransitionResult<ClaimDisposition> {
  // Operator repair is the one door into every state, including terminal and
  // malformed, because it exists only to fix platform defects — and it is
  // itself a public ledger event carrying a mandatory reason.
  if (event.kind === "operator-repair") {
    if (event.reason.trim().length === 0) {
      return refuse("operator repair requires a public reason recorded on the ledger event");
    }
    return allow(event.to);
  }

  if (TERMINAL_STATES.includes(current)) {
    return refuse(`${current} is a terminal disposition`);
  }

  if (current === "malformed") {
    // The malformed exit rule: a statement defect cannot be cured in place by
    // any volume of review or evidence — proof evidence cannot cure a
    // statement defect — so the only exit is a new claim version.
    if (event.kind === "new-version") return allow("open");
    return refuse("malformed exits only via a new claim version");
  }

  if (event.kind === "new-version") {
    if (current === "draft") {
      return refuse("drafts are edited in place; only a published claim mints a new version");
    }
    // P9 (Fable section 6.3): editing mints @n+1 and RESETS the disposition to
    // open. The new head version is fresh, unreviewed content — reviews pin
    // versions, so every prior verdict stays attached to the version it
    // judged while this identity re-enters the machine at open. "superseded"
    // is for replaced identities, not a new version of the same one.
    return allow("open");
  }

  switch (event.kind) {
    case "promote": {
      if (current !== "draft") return refuse(`promote requires draft, got ${current}`);
      return allow("open");
    }

    case "review-verified": {
      const reviews = [...context.verified_reviews, event.review];
      if (event.review.finding === "statement-defect") {
        if (current === "open" || current === "disputed") return allow("malformed");
        return refuse(`a statement-defect finding cannot move ${current} to malformed`);
      }
      if (event.review.finding === "dispute") {
        if (LIVE_STATES.includes(current)) return allow("disputed");
        return refuse(`a dispute finding is not legal from ${current}`);
      }
      // finding === "support"
      if (current === "open") {
        const unmet = corroborationUnmet(reviews, context);
        return unmet.length === 0 ? allow("corroborated") : refuse(...unmet);
      }
      if (current === "corroborated") {
        const unmet = strongSupportUnmet(reviews, context);
        return unmet.length === 0 ? allow("strongly-supported") : refuse(...unmet);
      }
      return refuse(`a supporting review is not legal from ${current}`);
    }

    case "refutation-attempt-recorded": {
      // Recording an attempt never moves a disposition by itself; it satisfies
      // a precondition the next corroborating review checks. From any live state
      // this is a legal no-op on disposition — the claim stays in its current state.
      if (LIVE_STATES.includes(current)) return allow(current);
      return refuse(`recording a refutation attempt is not legal from ${current}`);
    }

    case "evidence-refuted": {
      if (current === "open" || current === "corroborated" || current === "strongly-supported") {
        // Refuting evidence lands. If it already stands confirmed and
        // unanswered the claim settles as refuted in one step; otherwise the
        // claim is disputed while the refutation is live and unresolved.
        return refutedUnmet(event).length === 0 ? allow("refuted") : allow("disputed");
      }
      if (current === "disputed") {
        const unmet = refutedUnmet(event);
        return unmet.length === 0 ? allow("refuted") : refuse(...unmet);
      }
      return refuse(`refuting evidence is not legal from ${current}`);
    }

    case "author-concession": {
      if (LIVE_STATES.includes(current)) return allow("refuted");
      return refuse(`author concession is not legal from ${current}`);
    }

    case "author-withdrawal": {
      if (LIVE_STATES.includes(current)) return allow("withdrawn");
      return refuse(`author withdrawal is not legal from ${current}`);
    }

    case "reduced-to": {
      if (!LIVE_STATES.includes(current)) {
        return refuse(`reduced-to is not legal from ${current}`);
      }
      if (event.target_claim_id.trim().length === 0) {
        return refuse("reduced-to requires a target claim");
      }
      return allow("reduced-to");
    }
  }
}

// ---------------------------------------------------------------------------
// Display: refuter-first and the machine-checked badge
// ---------------------------------------------------------------------------

/**
 * The public display string for a claim's disposition. Refuter-first (§6.4,
 * ADR-9): support without a recorded refutation attempt displays as
 * `open · unchallenged` however many agreeing verifications accumulate. A bare
 * open claim with no reviews at all displays as plain `open`.
 */
export function displayClaimDisposition(
  disposition: ClaimDisposition,
  context: ClaimTransitionContext,
): string {
  if (
    disposition === "open" &&
    context.verified_reviews.length > 0 &&
    context.recorded_refutation_attempts === 0
  ) {
    return "open · unchallenged";
  }
  return disposition;
}

/**
 * ADR-10 / §6.5: `machine-checked` is a display badge, never a disposition. A
 * claim wears it when its `strongly-supported` standing rests on a
 * certified-class artifact.
 */
export function wearsMachineCheckedBadge(
  disposition: ClaimDisposition,
  context: ClaimTransitionContext,
): boolean {
  return disposition === "strongly-supported" && context.has_certified_artifact;
}

// ---------------------------------------------------------------------------
// Hypothesis sub-machine (§6.4)
// ---------------------------------------------------------------------------

export type HypothesisEvent =
  /** Scope tightened by new information; the hypothesis survives in a narrower form. */
  | { readonly kind: "narrow" }
  /** The falsifier fired. killed_by MUST point at the evidence or review that fired it. */
  | { readonly kind: "kill"; readonly killed_by?: string }
  /** Parked with a stated reason; a deferred hypothesis can resume. */
  | { readonly kind: "defer" }
  /** A deferred hypothesis re-enters the live attack set. */
  | { readonly kind: "resume" }
  /** Replaced by a newer hypothesis object. */
  | { readonly kind: "supersede"; readonly successor_id: string };

const HYPOTHESIS_KILLABLE: readonly HypothesisDisposition[] = ["active", "narrowed", "deferred"];

export function evaluateHypothesisTransition(
  current: HypothesisDisposition,
  event: HypothesisEvent,
): TransitionResult<HypothesisDisposition> {
  if (current === "killed" || current === "superseded") {
    return refuse(`${current} is a terminal disposition`);
  }

  switch (event.kind) {
    case "narrow": {
      if (current === "active" || current === "narrowed") return allow("narrowed");
      return refuse(`narrow is not legal from ${current}`);
    }
    case "kill": {
      if (event.killed_by === undefined || event.killed_by.trim().length === 0) {
        return refuse(
          "kill requires killed_by pointing at the evidence or review that fired the falsifier",
        );
      }
      if (!HYPOTHESIS_KILLABLE.includes(current)) {
        return refuse(`kill is not legal from ${current}`);
      }
      return allow("killed");
    }
    case "defer": {
      if (current === "active" || current === "narrowed") return allow("deferred");
      return refuse(`defer is not legal from ${current}`);
    }
    case "resume": {
      if (current === "deferred") return allow("active");
      return refuse(`resume is not legal from ${current}`);
    }
    case "supersede": {
      if (event.successor_id.trim().length === 0) {
        return refuse("supersede requires a successor hypothesis");
      }
      return allow("superseded");
    }
  }
}

/**
 * Survival is never a green check (§6.4): a live hypothesis displays as
 * exactly "surviving current tests" — survival ≠ truth.
 */
export function displayHypothesisDisposition(disposition: HypothesisDisposition): string {
  if (disposition === "active") return "surviving current tests";
  if (disposition === "narrowed") return "narrowed · surviving current tests";
  return disposition;
}

// ---------------------------------------------------------------------------
// Independence tiers (§6.6): computed and pinned at review time
// ---------------------------------------------------------------------------

export function computeIndependenceTier(
  reviewerSponsorId: string,
  authorSponsorId: string,
  reviewerModelFamily: string,
  authorModelFamily: string,
  disjointMethod: boolean,
): IndependenceTier {
  if (reviewerSponsorId === authorSponsorId) return "T0";
  if (reviewerModelFamily === authorModelFamily) return "T1";
  return disjointMethod ? "T3" : "T2";
}

/**
 * A review's independence pinned at review time from the sponsor-of-record and
 * declared family at that moment. Independence is a fact about the moment of
 * verification.
 */
export interface PinnedIndependence {
  readonly tier: IndependenceTier;
  readonly pinned_at: {
    readonly reviewer_sponsor_id: string;
    readonly author_sponsor_id: string;
    readonly reviewer_model_family: string;
    readonly author_model_family: string;
    readonly disjoint_method: boolean;
    readonly reviewed_at: string;
  };
}

export function pinIndependenceAtReviewTime(
  reviewerSponsorId: string,
  authorSponsorId: string,
  reviewerModelFamily: string,
  authorModelFamily: string,
  disjointMethod: boolean,
  reviewedAt: string,
): PinnedIndependence {
  return {
    tier: computeIndependenceTier(
      reviewerSponsorId,
      authorSponsorId,
      reviewerModelFamily,
      authorModelFamily,
      disjointMethod,
    ),
    pinned_at: {
      reviewer_sponsor_id: reviewerSponsorId,
      author_sponsor_id: authorSponsorId,
      reviewer_model_family: reviewerModelFamily,
      author_model_family: authorModelFamily,
      disjoint_method: disjointMethod,
      reviewed_at: reviewedAt,
    },
  };
}

/**
 * Retroactive-upgrade refusal (§6.6, Rev 3.1): a later sponsorship transfer,
 * Fellow re-declaration, or roster change never upgrades a recorded tier,
 * because manufacturing independence after the fact is a named attack. A
 * recomputation that agrees with the pin is a no-op; any drift is refused with
 * the exact recorded tier.
 */
export function recomputePinnedIndependence(
  pinned: PinnedIndependence,
  currentReviewerSponsorId: string,
  currentAuthorSponsorId: string,
  currentReviewerModelFamily: string,
  currentAuthorModelFamily: string,
  currentDisjointMethod: boolean,
): TransitionResult<IndependenceTier> {
  const now = computeIndependenceTier(
    currentReviewerSponsorId,
    currentAuthorSponsorId,
    currentReviewerModelFamily,
    currentAuthorModelFamily,
    currentDisjointMethod,
  );
  if (now === pinned.tier) return allow(pinned.tier);
  return refuse(
    `independence tier is pinned at review time (${pinned.tier}); a later sponsorship transfer, re-declaration, or roster change never retroactively upgrades a recorded tier (recomputed ${now})`,
  );
}

// ---------------------------------------------------------------------------
// Computed facets: review-state and staleness (§6.4, ADR-21)
// ---------------------------------------------------------------------------

export interface ReviewFacetRecord {
  readonly status: "in-progress" | "completed";
  readonly verified: boolean;
  readonly tier: IndependenceTier;
  readonly finding: "support" | "dispute" | "statement-defect";
}

export interface ClaimFacetInput {
  readonly review_requested: boolean;
}

/**
 * The review-state facet, computed and never author-writable: a claim can be
 * well-evidenced yet unreviewed, or reviewed yet weakly evidenced. Precedence:
 * a live contest outranks a clean check, which outranks work in flight, which
 * outranks a bare request.
 */
export function computeReviewStateFacet(
  claim: ClaimFacetInput,
  reviews: readonly ReviewFacetRecord[],
): ReviewStateFacet {
  const completed = reviews.filter((review) => review.status === "completed");
  if (completed.some((review) => review.finding === "dispute")) return "contested";
  if (completed.some((review) => review.verified && tierAtLeast(review.tier, "T1"))) {
    return "independently-checked";
  }
  if (reviews.some((review) => review.status === "in-progress")) return "under-review";
  if (claim.review_requested) return "review-requested";
  return "unreviewed";
}

export interface StalenessEvent {
  readonly kind: "evidence-invalidated" | "evidence-retracted" | "evidence-superseded";
  readonly evidence_id: string;
}

export interface StalenessFacet {
  readonly stale: boolean;
  /** The rested-on evidence ids whose invalidation flags this claim. */
  readonly flagged_evidence_ids: readonly string[];
  readonly display: "stale" | "fresh";
}

/**
 * The staleness facet: when evidence a disposition rests on is invalidated,
 * retracted, or superseded, the disposition is flagged `stale` and re-evaluated
 * rather than remaining cosmetically green.
 */
export function computeStalenessFacet(
  claim: { readonly resting_on_evidence_ids: readonly string[] },
  events: readonly StalenessEvent[],
): StalenessFacet {
  const invalidated = new Set(events.map((event) => event.evidence_id));
  const flagged = claim.resting_on_evidence_ids.filter((id) => invalidated.has(id));
  return {
    stale: flagged.length > 0,
    flagged_evidence_ids: flagged,
    display: flagged.length > 0 ? "stale" : "fresh",
  };
}
