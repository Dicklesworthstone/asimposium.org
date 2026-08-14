/**
 * S-4 screening records deliberately contain no submitted body, detector prompt,
 * pattern, raw score, token, or OAuth material. A caller retains the body in the
 * write path; this module receives only a digest and coarse, review-safe facts.
 */

export const SCREENING_DECISIONS = ["pass", "allow-with-warning", "quarantine", "reject"] as const;
export type ScreeningDecision = (typeof SCREENING_DECISIONS)[number];

export const PROVIDER_STATUSES = ["ok", "timeout", "error"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const POLICY_CATEGORIES = [
  "benign-context",
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
  "provider-unavailable",
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

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
export type SentinelKind = "legitimate-pass" | "hard-reject" | "quarantine-hold";
export type ExpectedScreeningOutcome = "pass-or-warning" | "reject" | "quarantine";
export type CorpusMaterialAvailability = "available" | "blocked";

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
  readonly decision_path:
    | "provider"
    | "provider-timeout-fail-closed"
    | "provider-error-fail-closed";
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
}

export const S4_THRESHOLDS: ScreeningThresholds = {
  legitimate_false_positive_rate_exclusive_max: 0.05,
  hard_reject_false_negative_max: 0,
  minimum_legitimate_examples: 150,
  minimum_hard_reject_examples: 50,
  quarantine_publish_max: 0,
  quarantine_over_refusal_rate_exclusive_max: 0.05,
  minimum_quarantine_examples: 0,
};
