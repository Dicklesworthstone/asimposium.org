/**
 * S-4 screening records deliberately contain no submitted body, detector prompt,
 * pattern, raw score, token, or OAuth material. A caller retains the body in the
 * write path; this module receives only a digest and coarse, review-safe facts.
 *
 * The decision, provider-status, category, and decision-path vocabularies are
 * NOT restated here. They are read from `@asimposium/contracts`, which is the
 * source of truth (AGENTS.md, "Contracts Before Endpoints"). An earlier revision
 * transcribed them as local literals; three copies of one vocabulary agreed only
 * by hand, and nothing made them keep agreeing. Reading the enums means a literal
 * added or removed in `packages/contracts/src/screening.ts` reaches this module
 * in the same change or fails to compile.
 */

import {
  type ScreeningCoarseCategory,
  ScreeningCoarseCategorySchema,
  type ScreeningDecisionPath,
  type ScreeningOutcome,
  ScreeningOutcomeSchema,
  type ScreeningProviderStatus,
  ScreeningProviderStatusSchema,
} from "@asimposium/contracts";

export const SCREENING_DECISIONS = ScreeningOutcomeSchema.options;
export type ScreeningDecision = ScreeningOutcome;

export const PROVIDER_STATUSES = ScreeningProviderStatusSchema.options;
export type ProviderStatus = ScreeningProviderStatus;

export const POLICY_CATEGORIES = ScreeningCoarseCategorySchema.options;
export type PolicyCategory = ScreeningCoarseCategory;

/**
 * The two decision-path sets below are deliberately *narrower* than the contract
 * enum, and each is written as an `Extract` over it rather than as a fresh union.
 * Naming a path the contract does not have collapses that member to `never` and
 * breaks compilation at the assignment; dropping one from the contract drops it
 * here too. Narrowing stays a decision this module makes, and stays legible as
 * one, without the member spellings becoming a second source of truth.
 */
export type ObservationDecisionPath = Extract<
  ScreeningDecisionPath,
  "provider" | "provider-timeout-fail-closed" | "provider-error-fail-closed"
>;

/**
 * Every contract path except `benign-outage-degraded`, which is not a decision
 * this seam can reach: publishing during an outage is a harness-fixture path
 * layered on top of a fail-closed result, never something the provider seam
 * returns on its own.
 */
export type ContextualDecisionPath = Extract<
  ScreeningDecisionPath,
  | "provider"
  | "provider-contextual-hold"
  | "direct-content-hold"
  | "direct-content-reject"
  | "direct-content-warning"
  | "provider-timeout-fail-closed"
  | "provider-error-fail-closed"
>;

/**
 * `quarantine` is a measured class, not a leftover. Its correct outcome is a
 * hold: not published, not hard-rejected, appealable (Fable §7.7's two
 * transparency classes, ADR-18's quarantine-first-on-uncertainty). It is scored
 * in two directions because they are not equally bad — publishing an item that
 * should have been held is the unsafe direction, and rejecting one is the
 * over-refusal direction (see `ScreeningThresholds`).
 */
export type GroundTruth = "legitimate" | "hard-reject" | "quarantine";
export type ScoreBand = "low" | "elevated" | "high";
export const SENTINEL_KINDS = ["legitimate-pass", "hard-reject", "quarantine-hold"] as const;
export type SentinelKind = (typeof SENTINEL_KINDS)[number];
export type ExpectedScreeningOutcome = "pass-or-warning" | "reject" | "quarantine";
export type CorpusMaterialAvailability = "available" | "blocked";

/**
 * Immutable meaning of each S4 control. Corpus entries may label themselves
 * with a sentinel only when their declared ground truth and expected outcome
 * equal this definition.
 */
export interface SentinelControlDefinition {
  readonly ground_truth: GroundTruth;
  readonly expected_outcome: ExpectedScreeningOutcome;
}

export const SENTINEL_CONTROL_DEFINITIONS: Readonly<
  Record<SentinelKind, SentinelControlDefinition>
> = {
  "legitimate-pass": {
    ground_truth: "legitimate",
    expected_outcome: "pass-or-warning",
  },
  "hard-reject": {
    ground_truth: "hard-reject",
    expected_outcome: "reject",
  },
  "quarantine-hold": {
    ground_truth: "quarantine",
    expected_outcome: "quarantine",
  },
};

/**
 * Every corpus entry records where its evaluated body comes from. `blocked`
 * means the body/digest has not been supplied; it is never eligible for an
 * FP/FN result. Locators are opaque staging handles, not public body URLs.
 */
export interface ScreeningCorpusSource {
  readonly kind: "inline-safe" | "protected-staging";
  readonly locator: string;
  readonly version: string;
  readonly provenance: string;
  readonly license: string;
  readonly availability: CorpusMaterialAvailability;
}

/** A versioned manifest entry. `body` is retained only for safe inline examples. */
export interface ScreeningCorpusExample {
  readonly manifest_version: "s4-manifest-v2";
  readonly id: string;
  /** SHA-256 of the body actually evaluated, absent only for an explicit BLOCKED entry. */
  readonly body_digest?: string;
  readonly body?: string;
  readonly source: ScreeningCorpusSource;
  readonly ground_truth: GroundTruth;
  readonly expected_outcome: ExpectedScreeningOutcome;
  readonly policy_category: PolicyCategory;
  readonly stratum: string;
  /** Why this exact item belongs in the corpus; never a detector explanation. */
  readonly rationale: string;
  readonly safe_excerpt: string;
  readonly aggregation_pair_id?: string;
  readonly aggregation_member?: "a" | "b";
  readonly sentinel?: SentinelKind;
}

/** A provider result after policy translation. Numeric/raw detector scores stay outside this interface. */
export interface ScreeningObservation {
  readonly example_id: string;
  /** Staging attestation of the body it screened; must equal manifest body_digest. */
  readonly evaluated_body_digest: string;
  readonly decision: ScreeningDecision;
  readonly coarse_category: PolicyCategory;
  readonly category_score_bands: Readonly<Record<PolicyCategory, ScoreBand | undefined>>;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly provider_status: ProviderStatus;
  readonly decision_path: ObservationDecisionPath;
  readonly status_code: "SCREENED" | "SCREENING_PROVIDER_TIMEOUT" | "SCREENING_PROVIDER_ERROR";
  readonly latency_ms: number;
  readonly retry_count: number;
}

export interface ScreeningRunIdentity {
  readonly corpus_revision: string;
  readonly corpus_digest: string;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
}

export interface ScreeningProviderRequest {
  readonly example_id: string;
  readonly body_digest: string;
  readonly context_digest: string;
  readonly identity: ScreeningRunIdentity;
}

/**
 * The live Worker adapter is injected by the route owner once a Workers AI
 * binding exists. Tests of aggregate logic must not be reported as that probe.
 */
export interface ScreeningProvider {
  screen(
    request: ScreeningProviderRequest,
    signal: AbortSignal,
  ): Promise<{
    decision: ScreeningDecision;
    coarse_category: PolicyCategory;
    category_score_bands: Readonly<Record<PolicyCategory, ScoreBand | undefined>>;
  }>;
}

/**
 * Ephemeral input for the promotion-time contextual screen.
 *
 * This is intentionally separate from `ScreeningObservation`: the latter is
 * an OPS-safe measurement receipt, while this value contains untrusted
 * scientific text and exists only for the duration of one provider call.
 */
export interface ContextualScreeningInput {
  /** Bounded statement fetched from the server-owned problem record. */
  readonly problem_statement: string;
  /** Every outward field of the proposed public promotion, bounded before provider ingress. */
  readonly current_promotion: ContextualPromotionCandidate;
  /** The newest bounded rows, presented oldest-to-newest before the current promotion. */
  readonly recent_same_fellow_promotions: readonly ContextualPromotionCandidate[];
}

export interface ContextualPromotionCandidate {
  readonly title: string;
  readonly extract: string;
  readonly statement: string;
  readonly public_artifact_md: string;
}

/** Versioned, safe-to-retain identity for a contextual decision. */
export interface ContextualScreeningIdentity {
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
}

/** The direct-content screen runs first and is never softened by contextual screening. */
export interface DirectContentScreeningVerdict {
  readonly decision: ScreeningDecision;
  readonly coarse_category: PolicyCategory;
}

/**
 * The contextual provider is a narrow ingress-only seam. Implementations must
 * not retain `ContextualScreeningInput`; durable receipts carry only the
 * result type below.
 */
export interface ContextualScreeningProvider {
  screenContextually(
    input: ContextualScreeningInput,
    signal: AbortSignal,
  ): Promise<{
    decision: ScreeningDecision;
    coarse_category: PolicyCategory;
  }>;
}

/**
 * Safe to persist in a private hold or return as a coarse refusal. It contains
 * neither submitted text nor any reconstruction of the supplied context.
 */
export interface ContextualScreeningResult {
  readonly input_digest: string;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly decision: ScreeningDecision;
  readonly coarse_category: PolicyCategory;
  readonly provider_status: ProviderStatus;
  readonly decision_path: ContextualDecisionPath;
  readonly status_code: "SCREENED" | "SCREENING_PROVIDER_TIMEOUT" | "SCREENING_PROVIDER_ERROR";
}

export interface ScreeningThresholds {
  readonly legitimate_false_positive_rate_exclusive_max: number;
  readonly hard_reject_false_negative_max: number;
  readonly minimum_legitimate_examples: number;
  readonly minimum_hard_reject_examples: number;
  /**
   * Quarantine-truth items published anyway (`pass` / `allow-with-warning`).
   * A **count**, not a rate, and the ceiling is zero: this is the same kind of
   * claim as the hard-reject false-negative target — content that should have
   * been held reached a public face, and one instance is one too many.
   */
  readonly quarantine_publish_max: number;
  /**
   * Quarantine-truth items hard-rejected instead of held. Deliberately shares
   * the 5% bar with the legitimate false-positive rate: both say "the screen
   * was harsher than the ground truth requires", and reusing the published
   * number avoids inventing a second threshold nobody has calibrated. Unlike a
   * publish, an over-refusal is recoverable through the appeal path, so it is a
   * rate rather than a count.
   */
  readonly quarantine_over_refusal_rate_exclusive_max: number;
  /**
   * Zero today: the frozen 150/50 manifest carries no quarantine-truth entry,
   * and this file must not pretend otherwise. Raise it in the same revision
   * that adds the examples, so the class cannot be added silently and then go
   * unmeasured.
   */
  readonly minimum_quarantine_examples: number;
  /**
   * How many should-fail controls of each kind the corpus must carry.
   *
   * Without a floor here, deleting the sentinels deletes the alarm: a corpus
   * with no controls aggregates to exactly the same `sentinel_failures: []` as
   * one whose controls all passed, and the report cannot tell a reader which it
   * was looking at. These counts are the machine-checkable statement that the
   * FP and FN assertions were still able to fail on this run.
   *
   * `quarantine-hold` is zero for the same reason `minimum_quarantine_examples`
   * is: the frozen manifest carries no quarantine-truth entry. Raise the two
   * together.
   */
  readonly minimum_sentinel_controls: Readonly<Record<SentinelKind, number>>;
}

export const S4_THRESHOLDS: ScreeningThresholds = {
  legitimate_false_positive_rate_exclusive_max: 0.05,
  hard_reject_false_negative_max: 0,
  minimum_legitimate_examples: 150,
  minimum_hard_reject_examples: 50,
  quarantine_publish_max: 0,
  quarantine_over_refusal_rate_exclusive_max: 0.05,
  minimum_quarantine_examples: 0,
  minimum_sentinel_controls: {
    "legitimate-pass": 1,
    "hard-reject": 1,
    "quarantine-hold": 0,
  },
};
