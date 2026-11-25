import { z } from "zod";
import { ClaimIdSchema } from "./scientific-provenance.ts";

export const PROBLEM_RESOLUTION_DIRECTIONS = [
  "affirmed",
  "refuted-as-stated",
  "closed-with-negative-result",
] as const;
export const ProblemResolutionDirectionSchema = z.enum(PROBLEM_RESOLUTION_DIRECTIONS);
export type ProblemResolutionDirection = z.infer<typeof ProblemResolutionDirectionSchema>;

/** The public limits of a resolution, authored by the Fellow who publishes
 * the closing synthesis. A sponsor selects that record; it cannot replace
 * these declarations with new scientific prose during terminal admission. */
export const ProblemNoClaimBoundarySchema = z
  .object({
    verified: z.array(z.string().min(1).max(500)).min(1),
    mechanisms: z.array(z.string().min(1).max(500)).min(1),
    independence_tiers: z.array(z.string().min(1).max(50)).min(1),
    remaining_external_validation: z.array(z.string().min(1).max(500)).min(1),
  })
  .strict();
export type ProblemNoClaimBoundary = z.infer<typeof ProblemNoClaimBoundarySchema>;

/** This declaration is an attributed work product, never a command to set
 * scientific standing. Resolution separately evaluates the exact current
 * result and requires earned independent support and available sources. */
export const ClosingSynthesisDeclarationSchema = z
  .object({
    result_claim: z
      .object({
        claim_id: ClaimIdSchema.max(47),
        version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    direction: ProblemResolutionDirectionSchema,
    no_claim_boundary: ProblemNoClaimBoundarySchema,
  })
  .strict();
export type ClosingSynthesisDeclaration = z.infer<typeof ClosingSynthesisDeclarationSchema>;

/** Structured, operator-verified external expert review record required before
 * any famous problem (`famous_guardrail IS NOT NULL`) in `under-result-review`
 * can admit `resolve` (Fable §6.2 & 2026-11-02 decision). Bare sponsor-typed
 * prose remains strictly inadmissible. */
export const ExternalExpertReviewIdPattern = /^EER-[0-9A-HJKMNP-TV-Z]{26}$/;
export const ExternalExpertReviewIdSchema = z
  .string()
  .regex(ExternalExpertReviewIdPattern, "invalid external expert review record id");
export type ExternalExpertReviewId = z.infer<typeof ExternalExpertReviewIdSchema>;

export const EXTERNAL_EXPERT_REVIEW_VERDICTS = [
  "supports-resolution",
  "withheld",
  "rejects-resolution",
] as const;
export const ExternalExpertReviewVerdictSchema = z.enum(EXTERNAL_EXPERT_REVIEW_VERDICTS);
export type ExternalExpertReviewVerdict = z.infer<typeof ExternalExpertReviewVerdictSchema>;

export const ExternalExpertReviewerAttributionSchema = z
  .object({
    name: z.string().min(1).max(200),
    affiliation: z.string().min(1).max(240),
    identifier: z.string().min(1).max(240),
  })
  .strict();
export type ExternalExpertReviewerAttribution = z.infer<
  typeof ExternalExpertReviewerAttributionSchema
>;

export const ExternalExpertReviewCreateRequestSchema = z
  .object({
    claim_id: ClaimIdSchema.max(47),
    claim_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reviewer: ExternalExpertReviewerAttributionSchema,
    attestation_locator: z
      .string()
      .min(8)
      .max(1024)
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("doi:10."),
        "attestation_locator must be a permanent https:// URL or doi:10.* identifier",
      ),
    attestation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: ExternalExpertReviewVerdictSchema,
    reviewed_at: z.string().datetime(),
    no_claim_boundary: ProblemNoClaimBoundarySchema,
  })
  .strict();
export type ExternalExpertReviewCreateRequest = z.infer<
  typeof ExternalExpertReviewCreateRequestSchema
>;

export const ExternalExpertReviewRecordSchema = z
  .object({
    review_record_id: ExternalExpertReviewIdSchema,
    problem_id: z.string().min(1).max(128),
    claim_id: ClaimIdSchema.max(47),
    claim_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    claim_content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reviewer: ExternalExpertReviewerAttributionSchema,
    attestation_locator: z.string().min(8).max(1024),
    attestation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: ExternalExpertReviewVerdictSchema,
    reviewed_at: z.string().datetime(),
    no_claim_boundary: ProblemNoClaimBoundarySchema,
    verified_by_operator_id: z.string().min(1).max(128),
    created_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
  })
  .strict();
export type ExternalExpertReviewRecord = z.infer<typeof ExternalExpertReviewRecordSchema>;
