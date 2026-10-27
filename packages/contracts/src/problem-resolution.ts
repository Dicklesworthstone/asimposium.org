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
