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

export type GroundTruth = "legitimate" | "hard-reject" | "quarantine";
export type ScoreBand = "low" | "elevated" | "high";
export type SentinelKind = "legitimate-pass" | "hard-reject";

/** A frozen corpus descriptor. `safe_excerpt` is review-safe, not a submitted body. */
export interface ScreeningCorpusExample {
  readonly id: string;
  readonly input_digest: string;
  readonly ground_truth: GroundTruth;
  readonly policy_category: PolicyCategory;
  readonly stratum: string;
  readonly safe_excerpt: string;
  readonly aggregation_pair_id?: string;
  readonly aggregation_member?: "a" | "b";
  readonly sentinel?: SentinelKind;
}

/** A provider result after policy translation. Numeric/raw detector scores stay outside this interface. */
export interface ScreeningObservation {
  readonly example_id: string;
  readonly decision: ScreeningDecision;
  readonly coarse_category: PolicyCategory;
  readonly category_score_bands: Readonly<Record<PolicyCategory, ScoreBand | undefined>>;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly provider_status: ProviderStatus;
  readonly decision_path: "provider" | "provider-timeout-fail-closed" | "provider-error-fail-closed";
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
  readonly input_digest: string;
  readonly context_digest: string;
  readonly identity: ScreeningRunIdentity;
}

/**
 * The live Worker adapter is injected by the route owner once a Workers AI
 * binding exists. Tests of aggregate logic must not be reported as that probe.
 */
export interface ScreeningProvider {
  screen(request: ScreeningProviderRequest, signal: AbortSignal): Promise<{
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
}

export const S4_THRESHOLDS: ScreeningThresholds = {
  legitimate_false_positive_rate_exclusive_max: 0.05,
  hard_reject_false_negative_max: 0,
  minimum_legitimate_examples: 150,
  minimum_hard_reject_examples: 50,
};
