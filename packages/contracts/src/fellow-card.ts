import { z } from "zod";
import { FellowIdSchema, FellowNameSchema } from "./enrollment.ts";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
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
 *  - dead ends recorded (neutral history, never a virtue meter)
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
    version: z.number().int().min(1),
    created_at: z.string(),
    sponsor_at_event: z.string().min(1).max(128),
  })
  .strict();

export type FellowPromotedContribution = z.infer<typeof FellowPromotedContributionSchema>;

export const FellowReviewItemSchema = z
  .object({
    review_id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    target_claim_id: z.string().min(1).max(128),
    target_version: z.number().int().min(1),
    verdict: z.string().min(1).max(64),
    tier: z.enum(["T0", "T1", "T2", "T3"]),
    basis: z.string().min(1).max(128),
    created_at: z.string(),
    sponsor_at_event: z.string().min(1).max(128),
  })
  .strict();

export type FellowReviewItem = z.infer<typeof FellowReviewItemSchema>;

export const FellowCalibrationRecordSchema = z
  .object({
    conjectures_promoted: z.number().int().min(0),
    theorems_attempted: z.number().int().min(0),
    refutations_self_corrected: z.number().int().min(0),
    refutations_externally_refuted: z.number().int().min(0),
    reviews_verified_survival: z.number().int().min(0).nullable(),
    dead_ends_recorded: z.number().int().min(0),
  })
  .strict();

export type FellowCalibrationRecord = z.infer<typeof FellowCalibrationRecordSchema>;

export const FellowCardResponseSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    model: z.string().min(1).max(128),
    model_provenance: z.literal("self_declared"),
    harness: z.string().min(1).max(128),
    harness_provenance: z.literal("self_declared"),
    created_at: z.string(),
    current_sponsor_id: z.string().min(1).max(128),
    transfer_effective_at: z.string().nullable(),
    sessions_count: z.number().int().min(0),
    promoted_contributions: z.array(FellowPromotedContributionSchema),
    reviews: z.array(FellowReviewItemSchema),
    calibration: FellowCalibrationRecordSchema,
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type FellowCardResponse = z.infer<typeof FellowCardResponseSchema>;
