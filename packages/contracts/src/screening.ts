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
  "off-topic",
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
  "off-scope",
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
const ScreeningScreenHoldResponseSchema = z
  .object({
    code: z.literal("SCREENING_HOLD"),
    coarse_category: ScreeningCoarseCategorySchema,
    appeal: z.literal(SCREENING_APPEAL_CODE),
    /**
     * The private review case holding exactly these bytes. A reviewer's
     * decision reaches the author's inbox as a moderation_outcome notice
     * naming this case; a release publishes only the identical bytes.
     */
    case_id: z
      .string()
      .regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
  })
  .strict();

/**
 * A hold from the author's graduated posture (Fable §9.1): after repeated
 * content refusals every public write waits for review until the sponsor
 * clears it. It is not a judgement of these bytes, so it carries no screen
 * category: whatever the screen said, the author sees the same response, and
 * a probing Fellow learns nothing about which variant would pass
 * (asimposiumorg-2i3s).
 */
const ScreeningPostureHoldResponseSchema = z
  .object({
    code: z.literal("SCREENING_HOLD"),
    appeal: z.literal(SCREENING_APPEAL_CODE),
    case_id: z
      .string()
      .regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    posture: z.literal("quarantine-first"),
  })
  .strict();

export const ScreeningPromotionHoldResponseSchema = z.union([
  ScreeningScreenHoldResponseSchema,
  ScreeningPostureHoldResponseSchema,
]);
export type ScreeningPromotionHoldResponse = z.infer<typeof ScreeningPromotionHoldResponseSchema>;

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

/** Relevance is not abuse: retain the work while excluding it from discovery. */
const PublishedOffScopePublicActionSchema = z
  .object({
    category: z.literal("off-topic"),
    action: z.literal("published-with-warning"),
    notice: z.literal("off-scope"),
  })
  .strict();

/** Public context note attached to the exact published item. No detector evidence is public. */
export const ScreeningPublicationNoticeSchema = z.union([
  PublishedWithWarningPublicActionSchema,
  PublishedOffScopePublicActionSchema,
]);
export type ScreeningPublicationNotice = z.infer<typeof ScreeningPublicationNoticeSchema>;

/** Public archive metadata is separate from immutable scientific event bytes.
 * Its digest proves export self-consistency; an event-chain checkpoint does
 * not authenticate this companion or certify the underlying scientific work. */
export const ScreeningExportContextSchema = z
  .object({
    control: z.literal("publication_context"),
    format: z.literal("asimposium.publication-context.v1"),
    problem: z.string().regex(/^P-[A-Z0-9][A-Z0-9-]{1,30}$/),
    through: z.number().int().nonnegative().max(10_000),
    assurance: z.literal("export-self-consistency-only"),
    notices: z
      .array(
        z
          .object({
            event_id: z.string().min(1).max(160).regex(/\S/),
            seq: z.number().int().positive().max(10_000),
            payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            screening_notice: ScreeningPublicationNoticeSchema,
          })
          .strict(),
      )
      .max(10_000),
    context_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    let previous = 0;
    for (const [index, notice] of value.notices.entries()) {
      if (notice.seq <= previous || notice.seq > value.through || ids.has(notice.event_id)) {
        context.addIssue({
          code: "custom",
          path: ["notices", index],
          message: "Archive notices must be unique and ordered within the exact exported cut.",
        });
      }
      ids.add(notice.event_id);
      previous = notice.seq;
    }
  });
export type ScreeningExportContext = z.infer<typeof ScreeningExportContextSchema>;

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
  PublishedOffScopePublicActionSchema,
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

/** A public immutable source identity; no authored body belongs in a receipt. */
const PublicationContextSourceIdentitySchema = z
  .object({
    event_id: z.string().min(1).max(128),
    seq: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    payload_digest: ScreeningDigestSchema,
  })
  .strict();

const ContextProblemStatementSchema = z
  .object({
    version: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().max(120),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().max(8192),
    motivation: z.string().max(8192),
    source_event: PublicationContextSourceIdentitySchema.nullable(),
  })
  .strict();
const RecentContextPublicationSchema = PublicationContextSourceIdentitySchema.extend({
  payload_json: z
    .string()
    .min(1)
    .max(512 * 1024),
}).strict();
const PendingContextCandidateSchema = z
  .object({
    ordinal: z.int().min(1).max(15),
    kind: z.string().min(1).max(64),
    statement: z.string().max(1024 * 1024),
    falsifier: z
      .string()
      .max(1024 * 1024)
      .nullable(),
  })
  .strict();
const CONTEXT_INPUT_COMMON = {
  version: z.literal("publication-context.v1"),
  problem_id: z.string().min(1).max(64),
  fellow_id: z.string().min(1).max(128),
  limits: z
    .object({ recent_publications: z.literal(6), total_input_bytes: z.literal(1048576) })
    .strict(),
} as const;

/** The exact contextual input, visible only on a private operator case. */
export const ScreeningPublicationContextInputSchema = z.union([
  z
    .object({
      ...CONTEXT_INPUT_COMMON,
      mode: z.literal("public-problem"),
      problem_statement: ContextProblemStatementSchema,
      same_fellow_public_head: PublicationContextSourceIdentitySchema.nullable(),
      recent_same_fellow_publications: z.array(RecentContextPublicationSchema).max(6),
      omitted_older_publication_count: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      pending_batch_candidates: z.array(PendingContextCandidateSchema).max(15),
    })
    .strict(),
  z
    .object({
      ...CONTEXT_INPUT_COMMON,
      mode: z.literal("initial-publication"),
      problem_statement: z.null(),
      same_fellow_public_head: z.null(),
      recent_same_fellow_publications: z.array(RecentContextPublicationSchema).max(0),
      omitted_older_publication_count: z.literal(0),
      pending_batch_candidates: z.array(PendingContextCandidateSchema).max(0),
    })
    .strict(),
]);
export type ScreeningPublicationContextInput = z.infer<
  typeof ScreeningPublicationContextInputSchema
>;

const PUBLICATION_PROVENANCE_COMMON = {
  principal: z.literal("platform:symposiarch"),
  input_digest: ScreeningDigestSchema,
  context_digest: ScreeningDigestSchema,
  model_version: ScreeningVersionIdentifierSchema,
  policy_version: ScreeningVersionIdentifierSchema,
  configuration_digest: ScreeningDigestSchema,
  decided_at: z.string().datetime({ offset: true }).max(40),
  latency_ms: z.number().nonnegative(),
  retry_count: z.int().nonnegative(),
  outcome: z.literal("pass"),
  provider_status: z.literal("ok"),
  decision_path: z.enum(["provider", "operator-release"]),
  review_case_id: z
    .string()
    .regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
  public_action: PublishedPublicActionSchema,
} as const;

/** Legacy receipts retain their honest, narrower scope. */
const DirectPublicationProvenanceSchema = z
  .object({
    version: z.literal("ledger-publication-screening.v1"),
    scope: z.literal("candidate-and-actor-only"),
    ...PUBLICATION_PROVENANCE_COMMON,
  })
  .strict();

const DirectWarningPublicationProvenanceSchema = DirectPublicationProvenanceSchema.extend({
  outcome: z.literal("allow-with-warning"),
  decision_path: z.enum(["provider", "direct-content-warning"]),
  review_case_id: z.never().optional(),
  public_action: ScreeningPublicationNoticeSchema,
}).strict();

const CONTEXT_RECEIPT_COMMON = {
  version: z.literal("publication-context.v1"),
  pending_batch_candidates_digest: ScreeningDigestSchema,
} as const;
const PublicationContextReceiptSchema = z.union([
  z
    .object({
      ...CONTEXT_RECEIPT_COMMON,
      mode: z.literal("public-problem"),
      statement_version: z.int().positive().max(Number.MAX_SAFE_INTEGER),
      statement_digest: ScreeningDigestSchema,
      same_fellow_public_head: PublicationContextSourceIdentitySchema.nullable(),
      recent_publications: z.array(PublicationContextSourceIdentitySchema).max(6),
      omitted_older_publication_count: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      pending_batch_candidate_count: z.int().min(0).max(15),
    })
    .strict(),
  z
    .object({
      ...CONTEXT_RECEIPT_COMMON,
      mode: z.literal("initial-publication"),
      statement_version: z.null(),
      statement_digest: z.null(),
      same_fellow_public_head: z.null(),
      recent_publications: z.array(PublicationContextSourceIdentitySchema).max(0),
      omitted_older_publication_count: z.literal(0),
      pending_batch_candidate_count: z.literal(0),
    })
    .strict(),
]);

/** Digest-only evidence of the exact public context and unpublished prefix. */
const ContextualPublicationProvenanceSchema = z
  .object({
    version: z.literal("ledger-publication-screening.v2"),
    scope: z.literal("candidate-and-public-context"),
    ...PUBLICATION_PROVENANCE_COMMON,
    candidate_digest: ScreeningDigestSchema,
    context: PublicationContextReceiptSchema,
  })
  .strict();

const ContextualWarningPublicationProvenanceSchema = ContextualPublicationProvenanceSchema.extend({
  outcome: z.literal("allow-with-warning"),
  decision_path: z.enum(["provider", "direct-content-warning"]),
  review_case_id: z.never().optional(),
  public_action: ScreeningPublicationNoticeSchema,
}).strict();

export const ScreeningPublicationProvenanceSchema = z
  .union([
    DirectPublicationProvenanceSchema,
    ContextualPublicationProvenanceSchema,
    DirectWarningPublicationProvenanceSchema,
    ContextualWarningPublicationProvenanceSchema,
  ])
  .refine(
    (value) =>
      (value.decision_path === "operator-release") === (value.review_case_id !== undefined),
    "an operator release names its review case, and only a release does",
  );
export type ScreeningPublicationProvenance = z.infer<typeof ScreeningPublicationProvenanceSchema>;

/** A provider warning publishes without opening an operator-review queue. */
const ProviderWarningReceiptSchema = z
  .object({
    ...PROMOTION_PROVENANCE_BASE,
    outcome: z.literal("allow-with-warning"),
    public_action: ScreeningPublicationNoticeSchema,
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
    public_action: ScreeningPublicationNoticeSchema,
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
  Category extends ScreeningCoarseCategory,
  Action extends ScreeningPublicationAction,
  DecisionPath extends ScreeningDecisionPath,
> = Action extends "published-with-warning"
  ? Category extends "off-topic"
    ? "off-scope"
    : DecisionPath extends "benign-outage-degraded"
      ? "screening-degraded"
      : "screening-warning"
  : "none";

function publicNoticeForScreeningContract<
  Category extends ScreeningCoarseCategory,
  Action extends ScreeningPublicationAction,
  DecisionPath extends ScreeningDecisionPath,
>(
  category: Category,
  action: Action,
  decisionPath: DecisionPath,
): PublicNoticeForScreeningContract<Category, Action, DecisionPath> {
  if (action !== "published-with-warning") {
    return "none" as PublicNoticeForScreeningContract<Category, Action, DecisionPath>;
  }
  return (
    category === "off-topic"
      ? "off-scope"
      : decisionPath === "benign-outage-degraded"
        ? "screening-degraded"
        : "screening-warning"
  ) as PublicNoticeForScreeningContract<Category, Action, DecisionPath>;
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
  const notice = publicNoticeForScreeningContract(category, action, decisionPath);
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
    "off-topic",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "provider",
    "not-required",
  ),
  matchedScreeningContractSchema(
    "off-topic",
    "published-with-warning",
    "allow-with-warning",
    "ok",
    "direct-content-warning",
    "not-required",
  ),
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
  ScreeningPublicationProvenanceSchema,
  ScreeningExportContextSchema,
]);
export type ScreeningSchemaDocument = z.infer<typeof ScreeningSchemaDocumentSchema>;
