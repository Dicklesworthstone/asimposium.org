import { z } from "zod";

/**
 * Symposiarch screening contracts (Fable §7.7 and §9.1).
 *
 * The public moderation log is deliberately only a category and action. The
 * promotion decision provenance binds the future promotion path to reproducible, bounded
 * facts without retaining a submission body, bounded-context bytes, detector
 * prompt, private pattern, raw score, credential, or hidden reasoning.
 */

export const SCREENING_OUTCOMES = ["pass", "allow-with-warning", "quarantine", "reject"] as const;
export const ScreeningOutcomeSchema = z.enum(SCREENING_OUTCOMES);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcomeSchema>;

export const SCREENING_COARSE_CATEGORIES = [
  "benign-context",
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
  "provider-unavailable",
] as const;
export const ScreeningCoarseCategorySchema = z.enum(SCREENING_COARSE_CATEGORIES);
export type ScreeningCoarseCategory = z.infer<typeof ScreeningCoarseCategorySchema>;

/** The only action spellings the public moderation log may expose. */
export const SCREENING_PUBLIC_ACTIONS = [
  "published",
  "published-with-warning",
  "quarantined",
  "rejected",
] as const;
export const ScreeningPublicationActionSchema = z.enum(SCREENING_PUBLIC_ACTIONS);
export type ScreeningPublicationAction = z.infer<typeof ScreeningPublicationActionSchema>;

/** Source-compatible public notices: coarse publication state, never detector detail. */
export const SCREENING_PUBLIC_NOTICES = [
  "none",
  "screening-warning",
  "screening-degraded",
] as const;
export const ScreeningPublicNoticeSchema = z.enum(SCREENING_PUBLIC_NOTICES);
export type ScreeningPublicNotice = z.infer<typeof ScreeningPublicNoticeSchema>;

const NonProviderUnavailableCategorySchema = z.enum([
  "benign-context",
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
]);

const HardPolicyCategorySchema = z.enum([
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
]);

/** The only appeal affordance exposed by a promotion-time policy decision. */
export const SCREENING_APPEAL_CODE = "SPONSOR_APPEAL_AVAILABLE" as const;

/**
 * A quarantine is an accepted private hold, not a public ledger write. Its
 * response deliberately omits detector detail, submitted bytes, prompt data,
 * scores, and model identity (Fable §7.7 / ADR-18).
 */
export const ScreeningPromotionHoldResponseSchema = z
  .object({
    code: z.literal("SCREENING_HOLD"),
    coarse_category: ScreeningCoarseCategorySchema,
    appeal: z.literal(SCREENING_APPEAL_CODE),
  })
  .strict();
export type ScreeningPromotionHoldResponse = z.infer<
  typeof ScreeningPromotionHoldResponseSchema
>;

/** A hard-policy refusal has the same intentionally starved public shape. */
export const ScreeningPromotionDeniedResponseSchema = z
  .object({
    code: z.literal("POLICY_DENIED"),
    coarse_category: HardPolicyCategorySchema,
    appeal: z.literal(SCREENING_APPEAL_CODE),
  })
  .strict();
export type ScreeningPromotionDeniedResponse = z.infer<
  typeof ScreeningPromotionDeniedResponseSchema
>;

export const ScreeningPromotionPolicyResponseSchema = z.union([
  ScreeningPromotionHoldResponseSchema,
  ScreeningPromotionDeniedResponseSchema,
]);
export type ScreeningPromotionPolicyResponse = z.infer<
  typeof ScreeningPromotionPolicyResponseSchema
>;

const PublishedPublicActionSchema = z
  .object({
    category: z.literal("benign-context"),
    action: z.literal("published"),
    notice: z.literal("none"),
  })
  .strict();

/** Fable §9.1's published context notice is only meaningful for a non-benign provider verdict. */
const PublishedWithWarningPublicActionSchema = z
  .object({
    category: HardPolicyCategorySchema,
    action: z.literal("published-with-warning"),
    notice: z.literal("screening-warning"),
  })
  .strict();

/** A deterministic benign decision may publish during an outage with a visible degraded notice. */
const PublishedWithDegradedWarningPublicActionSchema = z
  .object({
    category: z.literal("provider-unavailable"),
    action: z.literal("published-with-warning"),
    notice: z.literal("screening-degraded"),
  })
  .strict();

const QuarantinedPublicActionSchema = z
  .object({
    category: ScreeningCoarseCategorySchema,
    action: z.literal("quarantined"),
    notice: z.literal("none"),
  })
  .strict();

const RejectedPublicActionSchema = z
  .object({
    category: HardPolicyCategorySchema,
    action: z.literal("rejected"),
    notice: z.literal("none"),
  })
  .strict();

const NonProviderUnavailableQuarantineActionSchema = z
  .object({
    category: NonProviderUnavailableCategorySchema,
    action: z.literal("quarantined"),
    notice: z.literal("none"),
  })
  .strict();

const ProviderUnavailableQuarantineActionSchema = z
  .object({
    category: z.literal("provider-unavailable"),
    action: z.literal("quarantined"),
    notice: z.literal("none"),
  })
  .strict();

/**
 * Fable §9.1's quarantine notation: public metadata names the coarse category
 * and action, never the content or the reason a detector matched.
 */
export const ScreeningPublicActionSchema = z.union([
  PublishedPublicActionSchema,
  PublishedWithWarningPublicActionSchema,
  PublishedWithDegradedWarningPublicActionSchema,
  QuarantinedPublicActionSchema,
  RejectedPublicActionSchema,
]);
export type ScreeningPublicAction = z.infer<typeof ScreeningPublicActionSchema>;

/**
 * This is a narrow promotion-decision provenance envelope, not the canonical
 * screening log (which also carries corpus score bands, request/event ids,
 * latency, and retry evidence in the screening/local-worker subsystems).
 */
export const SCREENING_PROMOTION_DECISION_PROVENANCE_VERSION =
  "screening-promotion-decision-provenance.v1";

export const SCREENING_DECISION_PATHS = [
  "provider",
  "provider-contextual-hold",
  "direct-content-hold",
  "direct-content-reject",
  "direct-content-warning",
  "provider-timeout-fail-closed",
  "provider-error-fail-closed",
  "benign-outage-degraded",
] as const;
export const ScreeningDecisionPathSchema = z.enum(SCREENING_DECISION_PATHS);
export type ScreeningDecisionPath = z.infer<typeof ScreeningDecisionPathSchema>;

/** `ok` means the source completed a screening decision path; direct checks also use it. */
export const SCREENING_PROVIDER_STATUSES = ["ok", "timeout", "error"] as const;
export const ScreeningProviderStatusSchema = z.enum(SCREENING_PROVIDER_STATUSES);
export type ScreeningProviderStatus = z.infer<typeof ScreeningProviderStatusSchema>;

/** A quarantine waits for trained operator review; all other outcomes do not invent one. */
export const SCREENING_REVIEW_STATES = ["not-required", "pending-operator-review"] as const;
export const ScreeningReviewStateSchema = z.enum(SCREENING_REVIEW_STATES);
export type ScreeningReviewState = z.infer<typeof ScreeningReviewStateSchema>;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const ScreeningDigestSchema = z.string().regex(SHA256_HEX);

/** Version identifiers are bounded labels, never a raw prompt or provider response. */
export const ScreeningVersionIdentifierSchema = z.string().min(1).max(160).regex(IDENTIFIER);

const PROMOTION_PROVENANCE_BASE = {
  version: z.literal(SCREENING_PROMOTION_DECISION_PROVENANCE_VERSION),
  scope: z.literal("promotion"),
  input_digest: ScreeningDigestSchema,
  context_frontier_digest: ScreeningDigestSchema,
  context_omission_count: z.int().nonnegative(),
  model_version: ScreeningVersionIdentifierSchema,
  policy_version: ScreeningVersionIdentifierSchema,
  configuration_digest: ScreeningDigestSchema,
  decided_at: z.string().datetime({ offset: true }).max(40),
} as const;

/**
 * Every durable tuple is explicit so the generated Draft 2020-12 schema has
 * the same finite acceptance set as Zod. `ok` records a completed decision
 * path, including a deterministic direct path; it does not claim a provider ran.
 */
const PassReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("pass"),
    public_action: PublishedPublicActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("provider"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

/** A provider warning publishes without opening an operator-review queue. */
const ProviderWarningReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("allow-with-warning"),
    public_action: PublishedWithWarningPublicActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("provider"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

/** A deterministic direct warning is successful screening, not a skipped provider failure. */
const DirectContentWarningReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("allow-with-warning"),
    public_action: PublishedWithWarningPublicActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("direct-content-warning"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

/** Fixture-authorized deterministic benign publication during a provider outage. */
const BenignOutageTimeoutWarningReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("allow-with-warning"),
    public_action: PublishedWithDegradedWarningPublicActionSchema,
    provider_status: z.literal("timeout"),
    decision_path: z.literal("benign-outage-degraded"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

const BenignOutageErrorWarningReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("allow-with-warning"),
    public_action: PublishedWithDegradedWarningPublicActionSchema,
    provider_status: z.literal("error"),
    decision_path: z.literal("benign-outage-degraded"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

const ProviderContextualHoldReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("quarantine"),
    public_action: NonProviderUnavailableQuarantineActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("provider-contextual-hold"),
    reviewer_state: z.literal("pending-operator-review"),
  })
  .strict();

const DirectContentHoldReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("quarantine"),
    public_action: NonProviderUnavailableQuarantineActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("direct-content-hold"),
    reviewer_state: z.literal("pending-operator-review"),
  })
  .strict();

const ProviderTimeoutFailClosedReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("quarantine"),
    public_action: ProviderUnavailableQuarantineActionSchema,
    provider_status: z.literal("timeout"),
    decision_path: z.literal("provider-timeout-fail-closed"),
    reviewer_state: z.literal("pending-operator-review"),
  })
  .strict();

const ProviderErrorFailClosedReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("quarantine"),
    public_action: ProviderUnavailableQuarantineActionSchema,
    provider_status: z.literal("error"),
    decision_path: z.literal("provider-error-fail-closed"),
    reviewer_state: z.literal("pending-operator-review"),
  })
  .strict();

const ProviderRejectReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("reject"),
    public_action: RejectedPublicActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("provider"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

const DirectContentRejectReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("reject"),
    public_action: RejectedPublicActionSchema,
    provider_status: z.literal("ok"),
    decision_path: z.literal("direct-content-reject"),
    reviewer_state: z.literal("not-required"),
  })
  .strict();

export const ScreeningPromotionDecisionProvenanceSchema = z.union([
  PassReceiptSchema,
  ProviderWarningReceiptSchema,
  DirectContentWarningReceiptSchema,
  BenignOutageTimeoutWarningReceiptSchema,
  BenignOutageErrorWarningReceiptSchema,
  ProviderContextualHoldReceiptSchema,
  DirectContentHoldReceiptSchema,
  ProviderTimeoutFailClosedReceiptSchema,
  ProviderErrorFailClosedReceiptSchema,
  ProviderRejectReceiptSchema,
  DirectContentRejectReceiptSchema,
]);
export type ScreeningPromotionDecisionProvenance = z.infer<
  typeof ScreeningPromotionDecisionProvenanceSchema
>;

type PublicNoticeForScreeningContract<
  Action extends ScreeningPublicationAction,
  DecisionPath extends ScreeningDecisionPath,
> = Action extends "published-with-warning"
  ? DecisionPath extends "benign-outage-degraded"
    ? "screening-degraded"
    : "screening-warning"
  : "none";

function publicNoticeForScreeningContract<
  Action extends ScreeningPublicationAction,
  DecisionPath extends ScreeningDecisionPath,
>(
  action: Action,
  decisionPath: DecisionPath,
): PublicNoticeForScreeningContract<Action, DecisionPath> {
  if (action !== "published-with-warning") {
    return "none" as PublicNoticeForScreeningContract<Action, DecisionPath>;
  }
  return (
    decisionPath === "benign-outage-degraded" ? "screening-degraded" : "screening-warning"
  ) as PublicNoticeForScreeningContract<Action, DecisionPath>;
}

function matchedScreeningContractSchema<
  Category extends ScreeningCoarseCategory,
  Action extends ScreeningPublicationAction,
  Outcome extends ScreeningOutcome,
  ProviderStatus extends ScreeningProviderStatus,
  DecisionPath extends ScreeningDecisionPath,
  ReviewerState extends ScreeningReviewState,
>(
  category: Category,
  action: Action,
  outcome: Outcome,
  providerStatus: ProviderStatus,
  decisionPath: DecisionPath,
  reviewerState: ReviewerState,
) {
  const notice = publicNoticeForScreeningContract(action, decisionPath);
  const publicAction = z
    .object({ category: z.literal(category), action: z.literal(action), notice: z.literal(notice) })
    .strict();
  return z
    .object({
      public_action: publicAction,
      operator_receipt: z
        .object({
          ...PROMOTION_PROVENANCE_BASE,
          outcome: z.literal(outcome),
          public_action: publicAction,
          provider_status: z.literal(providerStatus),
          decision_path: z.literal(decisionPath),
          reviewer_state: z.literal(reviewerState),
        })
        .strict(),
    })
    .strict();
}

/** A durable public/operator receipt pair whose two faces describe one decision. */
export const ScreeningContractsSchema = z.union([
  matchedScreeningContractSchema(
    "benign-context",
    "published",
    "pass",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "injection",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "injection",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "provider-unavailable",
    "published-with-warning",
    "allow-with-warning",
    "timeout",
    "benign-outage-degraded",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "provider-unavailable",
    "published-with-warning",
    "allow-with-warning",
    "error",
    "benign-outage-degraded",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "benign-context",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "injection",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "quarantined",
    "quarantine",
    "ok",
    "provider-contextual-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "benign-context",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "injection",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "quarantined",
    "quarantine",
    "ok",
    "direct-content-hold",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "provider-unavailable",
    "quarantined",
    "quarantine",
    "timeout",
    "provider-timeout-fail-closed",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "provider-unavailable",
    "quarantined",
    "quarantine",
    "error",
    "provider-error-fail-closed",
    "pending-operator-review",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "injection",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "rejected",
    "reject",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "spam-commercial",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "injection",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "dual-use-boundary",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "operational-harm",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "harassment",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "sexual-content",
    "rejected",
    "reject",
    "ok",
    "direct-content-reject",
    "not-required",
  ),
]);
export type ScreeningContracts = z.infer<typeof ScreeningContractsSchema>;

/** Root served by `/schemas/screening.v1.json`. */
export const ScreeningSchemaDocumentSchema = z.union([
  ScreeningContractsSchema,
  ScreeningPromotionPolicyResponseSchema,
]);
export type ScreeningSchemaDocument = z.infer<typeof ScreeningSchemaDocumentSchema>;
