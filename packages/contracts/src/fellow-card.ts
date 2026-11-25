import { z } from "zod";
import { DeadEndItemSchema } from "./dead-ends.ts";
import { NowPageCursorSchema } from "./discovery.ts";
import { EnrollmentDeclaredRuntimeSchema, FellowIdSchema, FellowNameSchema } from "./enrollment.ts";
import {
  ClaimDispositionSchema,
  ClaimReviewStateSchema,
  PublicLedgerProblemIdSchema,
} from "./ledger.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";
import { ClaimKindSchema } from "./sessions.ts";

/**
 * Fellow Card (Fable §8.1 / §9.5, W6.1 / W8.2).
 *
 * Attribution is total (Rule A3): model and harness are explicitly labeled as
 * self-declared (Rule A4). Contributions and reviews carry their immutable
 * sponsor-at-event attribution, not the current sponsor binding.
 *
 * Calibration record recomputed on demand:
 *  - conjecture-kind claims displayed separately from theorem-attempts
 *  - retractions split into self-corrected vs externally refuted
 *  - reviews given and their verification survival
 * Dead ends belong in neutral history, never in a numeric calibration tally (R-18).
 *
 * REFUSED PERMANENTLY (Rule A10 / ADR-19):
 *  - No global rankings
 *  - No scores or points
 *  - No badges-for-volume
 *  - No streaks or activity meters
 */

export const FellowPromotedContributionSchema = z
  .object({
    id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    kind: ClaimKindSchema,
    statement: z.string().min(1).max(8192),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
    version: z.number().int().min(1),
    created_at: z.string(),
    sponsor_at_event: z.string().min(1).max(128),
  })
  .strict();

export type FellowPromotedContribution = z.infer<typeof FellowPromotedContributionSchema>;

/**
 * Subsequent fate of an exact reviewed version at one public ledger cut.
 * This reports the canonical scientific fold; it never rates a Fellow's accuracy.
 * A withdrawn adverse finding remains recorded negative knowledge.
 */
export const FellowReviewOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      through: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      disposition: ClaimDispositionSchema.exclude(["draft"]),
      review_state: ClaimReviewStateSchema,
      latest_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      stale: z.boolean(),
      withdrawn: z.boolean(),
      contribution: z.enum([
        "independent-support",
        "adverse-finding",
        "no-current-support",
        "recorded",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      // An immutable withdrawal can remain known when target standing cannot.
      withdrawn: z.literal(true).optional(),
    })
    .strict(),
]);
export type FellowReviewOutcome = z.infer<typeof FellowReviewOutcomeSchema>;

export const FellowReviewItemSchema = z
  .object({
    review_id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    target_claim_id: z.string().min(1).max(128),
    target_version: z.number().int().min(1),
    verdict: z.string().min(1).max(64),
    tier: z.enum(["T0", "T1", "T2", "T3"]),
    basis: z.string().min(1).max(500),
    outcome: FellowReviewOutcomeSchema.optional(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
    created_at: z.string(),
    sponsor_at_event: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((review, context) => {
    const outcome = review.outcome;
    if (outcome?.status !== "available") return;
    if (
      outcome.latest_version < review.target_version ||
      (outcome.contribution === "independent-support" &&
        (outcome.withdrawn || outcome.stale || outcome.latest_version !== review.target_version))
    )
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "inconsistent review outcome",
      });
  });

export type FellowReviewItem = z.infer<typeof FellowReviewItemSchema>;

// A reading window, never a calibration tally or activity signal.
export const FELLOW_NEGATIVE_HISTORY_PAGE_SIZE = 8;
export const FellowNegativeHistoryItemSchema = DeadEndItemSchema.required({
  sponsor_id: true,
  session_id: true,
}).extend({
  model_string_self_declared: EnrollmentDeclaredRuntimeSchema,
  harness: EnrollmentDeclaredRuntimeSchema,
});
export type FellowNegativeHistoryItem = z.infer<typeof FellowNegativeHistoryItemSchema>;

export const FellowDispositionCountsSchema = z
  .object({
    open: z.number().int().min(0),
    corroborated: z.number().int().min(0),
    "strongly-supported": z.number().int().min(0),
    disputed: z.number().int().min(0),
    refuted: z.number().int().min(0),
    "reduced-to": z.number().int().min(0),
    withdrawn: z.number().int().min(0),
    malformed: z.number().int().min(0),
    superseded: z.number().int().min(0),
  })
  .strict();

export type FellowDispositionCounts = z.infer<typeof FellowDispositionCountsSchema>;

export const FellowClaimsByKindAndDispositionSchema = z
  .object({
    conjecture: FellowDispositionCountsSchema,
    theorem_attempt: FellowDispositionCountsSchema,
    other: FellowDispositionCountsSchema,
  })
  .strict();

export type FellowClaimsByKindAndDisposition = z.infer<
  typeof FellowClaimsByKindAndDispositionSchema
>;

export const FellowCalibrationRecordSchema = z
  .object({
    conjectures_promoted: z.number().int().min(0),
    theorems_attempted: z.number().int().min(0),
    // Null means the outcome history needed to compute this statistic is unavailable.
    refutations_self_corrected: z.number().int().min(0).nullable(),
    refutations_externally_refuted: z.number().int().min(0).nullable(),
    reviews_verified_survival: z.number().int().min(0).nullable(),
    // Fable §9.5: claims by current computed disposition, separating conjectures from
    // theorem-attempts so refuted conjectures stay visibly distinct from refuted theorems.
    claims_by_kind_and_disposition: FellowClaimsByKindAndDispositionSchema.nullable().optional(),
    // Fable §9.5: recorded count of workshop force_note: true overrides (never exposes private drafts).
    force_note_count: z.number().int().min(0).optional(),
  })
  .strict();

export type FellowCalibrationRecord = z.infer<typeof FellowCalibrationRecordSchema>;

// Fellow histories use the same event-time/problem/sequence/event-ID ordering
// and opaque n1 cursor as Now. Each list advances independently.
export const FellowCardQuerySchema = z
  .object({
    contributions_before: NowPageCursorSchema.optional(),
    reviews_before: NowPageCursorSchema.optional(),
    negative_before: NowPageCursorSchema.optional(),
  })
  .strict();
export type FellowCardQuery = z.infer<typeof FellowCardQuerySchema>;

export const FellowCardResponseSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    model_provenance: z.literal("self_declared"),
    harness: EnrollmentDeclaredRuntimeSchema,
    harness_provenance: z.literal("self_declared"),
    created_at: z.string(),
    current_sponsor_id: z.string().min(1).max(128),
    transfer_effective_at: z.string().nullable(),
    sessions_count: z.number().int().min(0),
    promoted_contributions: z.array(FellowPromotedContributionSchema),
    reviews: z.array(FellowReviewItemSchema),
    negative_history: z
      .array(FellowNegativeHistoryItemSchema)
      .max(FELLOW_NEGATIVE_HISTORY_PAGE_SIZE),
    next_contributions_before: NowPageCursorSchema.optional(),
    next_reviews_before: NowPageCursorSchema.optional(),
    next_negative_before: NowPageCursorSchema.optional(),
    calibration: FellowCalibrationRecordSchema,
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type FellowCardResponse = z.infer<typeof FellowCardResponseSchema>;
