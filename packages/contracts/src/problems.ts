import { z } from "zod";
import { SponsorIdSchema } from "./enrollment.ts";
import { ProblemIndexTimestampSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import {
  type ClaimReanchorRequest,
  ClaimReanchorRequestSchema,
  type ClaimReanchorResponse,
  ClaimReanchorResponseSchema,
} from "./sessions.ts";

/**
 * W5.1 Problem lifecycle (Fable Rev 3.1 §6.2, §6.8, Rule P3).
 *
 * Problems begin in private-draft (sponsor + granted Fellows only).
 * Fellow-created problems always land in private-draft.
 * Publication (-> sharpening) is a sponsor/steward console action.
 * Sharpening locks the claims board until a non-proposer review lands statement-clear.
 * Active problems transition to dormant after 45 quiet days; any new event reactivates.
 * Claimed resolution enters under-result-review, then resolved or retired.
 * Resolved records direction and closing synthesis stating the no-claim boundary.
 */

export const PROBLEM_STATUSES = [
  "private-draft",
  "sharpening",
  "active",
  "dormant",
  "under-result-review",
  "resolved",
  "retired",
] as const;

export const ProblemStatusSchema = z.enum(PROBLEM_STATUSES);
export type ProblemStatus = z.infer<typeof ProblemStatusSchema>;

export const PROBLEM_RESOLUTION_DIRECTIONS = [
  "affirmed",
  "refuted-as-stated",
  "closed-with-negative-result",
] as const;

export const ProblemResolutionDirectionSchema = z.enum(PROBLEM_RESOLUTION_DIRECTIONS);
export type ProblemResolutionDirection = z.infer<typeof ProblemResolutionDirectionSchema>;

/** Famous-problem guardrail formulation and standing disclaimer (Fable §6.2). */
export const ProblemFamousGuardrailSchema = z
  .object({
    canonical_formulation: z.string().min(1).max(8192),
    variant_distinctions: z.string().min(1).max(8192),
    authoritative_references: z.array(z.string().min(1).max(1024)).min(1),
    standing_banner: z.string().min(1).max(1024),
  })
  .strict();

export type ProblemFamousGuardrail = z.infer<typeof ProblemFamousGuardrailSchema>;

/**
 * The no-claim boundary: exactly what was verified, by which mechanisms,
 * at which independence tiers, and what external validation remains (Fable §6.2).
 */
export const ProblemNoClaimBoundarySchema = z
  .object({
    verified: z.array(z.string().min(1).max(500)).min(1),
    mechanisms: z.array(z.string().min(1).max(500)).min(1),
    independence_tiers: z.array(z.string().min(1).max(50)).min(1),
    remaining_external_validation: z.array(z.string().min(1).max(500)).min(1),
  })
  .strict();

export type ProblemNoClaimBoundary = z.infer<typeof ProblemNoClaimBoundarySchema>;

export const ProblemClosingSynthesisSchema = z
  .object({
    summary: z.string().min(1).max(8192),
    no_claim_boundary: ProblemNoClaimBoundarySchema,
  })
  .strict();

export type ProblemClosingSynthesis = z.infer<typeof ProblemClosingSynthesisSchema>;

/** Problem statement versions S@1 -> S@n+1 (Fable §6.2, Rule P9). */
export const ProblemStatementVersionSchema = z
  .object({
    problem_id: PublicLedgerProblemIdSchema,
    version: z.number().int().positive(),
    statement: z.string().min(1).max(8192),
    norm_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    steward_accepted_by: z.string().min(1).max(128).optional(),
    created_at: ProblemIndexTimestampSchema,
  })
  .strict();

export type ProblemStatementVersion = z.infer<typeof ProblemStatementVersionSchema>;

export const SPONSOR_PROBLEM_BRIEF_STATUSES = ["active", "withdrawn", "adopted"] as const;
export const SponsorProblemBriefStatusSchema = z.enum(SPONSOR_PROBLEM_BRIEF_STATUSES);
export type SponsorProblemBriefStatus = z.infer<typeof SponsorProblemBriefStatusSchema>;

/**
 * Sponsor problem-intent / governance brief (Fable §6.2, A2/A3/ADR-7).
 * Private to the sponsor and assigned fellow; never enters public packs or search.
 */
export const SponsorProblemBriefSchema = z
  .object({
    id: z.string().min(1).max(128),
    sponsor_id: SponsorIdSchema,
    assigned_fellow_id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(120),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    areas: z.array(z.string().min(1).max(64)).min(1),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
    status: SponsorProblemBriefStatusSchema,
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();

export type SponsorProblemBrief = z.infer<typeof SponsorProblemBriefSchema>;

/** Fellow problem proposal: POST /v1/problems (propose-problems scope). */
export const ProposeProblemRequestSchema = z
  .object({
    brief_id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(120),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    areas: z.array(z.string().min(1).max(64)).min(1),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
    distinct_because: z.string().min(1).max(2048).optional(),
    unlisted: z.boolean().optional(),
  })
  .strict();

export type ProposeProblemRequest = z.infer<typeof ProposeProblemRequestSchema>;

/** Sponsor problem brief save/update: POST /v1/sponsors/problem-briefs. */
export const SaveProblemBriefRequestSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    assigned_fellow_id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(120),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    areas: z.array(z.string().min(1).max(64)).min(1),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
  })
  .strict();

export type SaveProblemBriefRequest = z.infer<typeof SaveProblemBriefRequestSchema>;

/** Sponsor problem lifecycle transition: POST /v1/sponsors/problems/:id/lifecycle. */
export const ProblemLifecycleActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("publish"),
    })
    .strict(),
  z
    .object({
      action: z.literal("revise-statement"),
      statement: z.string().min(1).max(8192),
      falsifier: z.string().min(1).max(8192),
      motivation: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      action: z.literal("enter-result-review"),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      direction: ProblemResolutionDirectionSchema,
      closing_synthesis: ProblemClosingSynthesisSchema,
      external_expert_review_proof: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("retire"),
      reason: z.string().min(1).max(2048),
    })
    .strict(),
]);

export type ProblemLifecycleActionRequest = z.infer<typeof ProblemLifecycleActionRequestSchema>;

/** Claim re-anchor to current problem statement version: POST /v1/sessions/:id/reanchor. */
export {
  type ClaimReanchorRequest,
  ClaimReanchorRequestSchema,
  type ClaimReanchorResponse,
  ClaimReanchorResponseSchema,
};

/** Canonical problem representation. */
export const ProblemDetailSchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    title: z.string().min(1).max(120),
    status: ProblemStatusSchema,
    unlisted: z.boolean(),
    sponsor_id: SponsorIdSchema.optional(),
    created_by_fellow_id: z.string().min(1).max(128).optional(),
    current_statement_version: z.number().int().positive(),
    public_seq: z.number().int().min(0),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    areas: z.array(z.string().min(1).max(64)),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
    resolution: z
      .object({
        direction: ProblemResolutionDirectionSchema,
        summary: z.string().min(1).max(8192),
        no_claim_boundary: ProblemNoClaimBoundarySchema,
      })
      .strict()
      .optional(),
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();

export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;

export const ProblemLifecycleContractsSchema = z
  .object({
    status: ProblemStatusSchema,
    resolution_direction: ProblemResolutionDirectionSchema,
    famous_guardrail: ProblemFamousGuardrailSchema,
    no_claim_boundary: ProblemNoClaimBoundarySchema,
    closing_synthesis: ProblemClosingSynthesisSchema,
    statement_version: ProblemStatementVersionSchema,
    brief: SponsorProblemBriefSchema,
    propose_request: ProposeProblemRequestSchema,
    save_brief_request: SaveProblemBriefRequestSchema,
    lifecycle_request: ProblemLifecycleActionRequestSchema,
    reanchor_request: ClaimReanchorRequestSchema,
    detail: ProblemDetailSchema,
  })
  .strict();
