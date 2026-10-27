import { z } from "zod";
import { AreaSlugSchema } from "./discovery.ts";
import { FellowLifecycleStatusSchema, SponsorIdSchema } from "./enrollment.ts";
import {
  ProblemNoClaimBoundarySchema,
  ProblemResolutionDirectionSchema,
} from "./problem-resolution.ts";
import { SynthesisIdSchema } from "./syntheses.ts";

export {
  PROBLEM_RESOLUTION_DIRECTIONS,
  type ProblemNoClaimBoundary,
  ProblemNoClaimBoundarySchema,
  type ProblemResolutionDirection,
  ProblemResolutionDirectionSchema,
} from "./problem-resolution.ts";

import {
  ClaimDependencyPinSchema,
  ProblemIndexTimestampSchema,
  ProblemStatusSchema,
  PublicLedgerProblemIdSchema,
} from "./ledger.ts";

import {
  type ClaimReanchorRequest,
  ClaimReanchorRequestSchema,
  type ClaimReanchorResponse,
  ClaimReanchorResponseSchema,
  SessionIdSchema,
} from "./sessions.ts";

export { PROBLEM_STATUSES, type ProblemStatus, ProblemStatusSchema } from "./ledger.ts";

/**
 * W5.1 Problem lifecycle (Fable Rev 3.1 §6.2, §6.8, Rule P3).
 *
 * Problems begin in private-draft (sponsor + granted Fellows only).
 * Fellow-created problems always land in private-draft.
 * Publication (-> sharpening) is a sponsor/steward console action.
 * Sharpening locks the claims board until a non-proposer review lands statement-clear.
 * Active problems transition to dormant after 45 quiet days; an object-level increment reactivates.
 * Claimed resolution enters under-result-review, then resolved or retired.
 * Resolved records direction and closing synthesis stating the no-claim boundary.
 */

export const PROBLEM_ROLES = ["observer", "contributor", "steward", "founding-steward"] as const;
export const ProblemRoleSchema = z.enum(PROBLEM_ROLES);
export type ProblemRole = z.infer<typeof ProblemRoleSchema>;

export const PROBLEM_ADMISSION_MODES = [
  "open",
  "approval-required",
  "invite-only",
  "archived-read-only",
] as const;
export const ProblemAdmissionModeSchema = z.enum(PROBLEM_ADMISSION_MODES);
export type ProblemAdmissionMode = z.infer<typeof ProblemAdmissionModeSchema>;

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
export const ProblemClosingSynthesisSchema = z
  .object({
    // Legacy requests still decode so admission can teach the missing exact
    // publication reference. A new resolution always requires this identity.
    synthesis_id: SynthesisIdSchema.optional(),
    summary: z.string().min(1).max(8192),
    no_claim_boundary: ProblemNoClaimBoundarySchema,
  })
  .strict();

export type ProblemClosingSynthesis = z.infer<typeof ProblemClosingSynthesisSchema>;

export const ProblemClosingSynthesisPublicationSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
    covers_through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((source) => source.covers_through < source.seq, {
    message: "Closing synthesis must cover an earlier ledger cut",
  });

export const ProblemResolutionRecordSchema = z
  .object({
    direction: ProblemResolutionDirectionSchema,
    summary: z.string().min(1).max(8192),
    no_claim_boundary: ProblemNoClaimBoundarySchema,
    result_claim: ClaimDependencyPinSchema,
    closing_synthesis: ProblemClosingSynthesisPublicationSchema,
  })
  .strict();
export type ProblemResolutionRecord = z.infer<typeof ProblemResolutionRecordSchema>;

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
    areas: z.array(AreaSlugSchema).min(1).max(32),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
    status: SponsorProblemBriefStatusSchema,
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();

export type SponsorProblemBrief = z.infer<typeof SponsorProblemBriefSchema>;

/** GET /v1/sponsors/problem-briefs: the sponsor's active (unadopted) briefs. */
export const SponsorProblemBriefListResponseSchema = z
  .object({ briefs: z.array(SponsorProblemBriefSchema).max(500) })
  .strict();
export type SponsorProblemBriefListResponse = z.infer<typeof SponsorProblemBriefListResponseSchema>;

/**
 * GET /v1/sponsors/problems: problems this sponsor owns or stewards, including private
 * drafts adopted by its Fellows, so the console can offer the lifecycle gate.
 * Private to the sponsor; never a public face.
 */
export const SponsorProblemSummarySchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    title: z.string().min(1).max(120),
    status: ProblemStatusSchema,
    unlisted: z.boolean(),
    created_by_fellow_id: z.string().min(1).max(128).nullable(),
    current_statement_version: z.number().int().positive(),
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();
export type SponsorProblemSummary = z.infer<typeof SponsorProblemSummarySchema>;

export const SponsorProblemListResponseSchema = z
  .object({ problems: z.array(SponsorProblemSummarySchema).max(500) })
  .strict();
export type SponsorProblemListResponse = z.infer<typeof SponsorProblemListResponseSchema>;

export const PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE = 100;
const GovernanceFellowIdSchema = z.string().min(1).max(128);

/** Keyset pagination within one currently authorized problem workspace. */
export const SponsorProblemGovernanceQuerySchema = z
  .object({
    after: GovernanceFellowIdSchema.optional(),
  })
  .strict();
export type SponsorProblemGovernanceQuery = z.infer<typeof SponsorProblemGovernanceQuerySchema>;

export const SponsorProblemGovernanceResponseSchema = z
  .object({
    problem: SponsorProblemSummarySchema.pick({
      id: true,
      title: true,
      status: true,
      unlisted: true,
      current_statement_version: true,
      updated_at: true,
    })
      .extend({
        admission_mode: ProblemAdmissionModeSchema,
        writer_cap: z.number().int().positive().nullable(),
      })
      .strict(),
    acting_sponsor_id: SponsorIdSchema,
    authority: z
      .object({
        owner: z.boolean(),
        steward: z.boolean(),
        can_edit_access: z.boolean(),
      })
      .strict(),
    members: z
      .array(
        z
          .object({
            fellow_id: GovernanceFellowIdSchema,
            name: z.string().min(1).max(128),
            role: z.enum(["observer", "contributor", "steward"]),
            fellow_status: FellowLifecycleStatusSchema,
            joined_at: ProblemIndexTimestampSchema,
          })
          .strict(),
      )
      .max(PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE),
    member_counts: z
      .object({
        total: z.number().int().nonnegative(),
        observer: z.number().int().nonnegative(),
        contributor: z.number().int().nonnegative(),
        steward: z.number().int().nonnegative(),
      })
      .strict(),
    has_more: z.boolean(),
    next_after: GovernanceFellowIdSchema.nullable(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const counts = page.member_counts;
    if (
      counts.total !== counts.observer + counts.contributor + counts.steward ||
      page.members.length > counts.total
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Membership counts must describe the complete workspace.",
      });
    }
    let previous = "";
    for (const member of page.members) {
      if (member.fellow_id <= previous)
        ctx.addIssue({
          code: "custom",
          message: "Member pages must contain distinct Fellow ids in ascending order.",
        });
      previous = member.fellow_id;
    }
    if (
      page.has_more
        ? page.members.length !== PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE ||
          page.next_after !== previous
        : page.next_after !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A truncated member page must identify its exact continuation.",
      });
    }
    if (
      (!page.authority.owner && !page.authority.steward) ||
      page.authority.can_edit_access !== !["resolved", "retired"].includes(page.problem.status)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Workspace capabilities must match current authority and lifecycle.",
      });
    }
  });
export type SponsorProblemGovernanceResponse = z.infer<
  typeof SponsorProblemGovernanceResponseSchema
>;

const AccessReceiptBaseSchema = z.object({
  problem_id: PublicLedgerProblemIdSchema,
  acting_sponsor_id: SponsorIdSchema,
  updated_at: ProblemIndexTimestampSchema,
  event_id: z.string().min(1).max(128).nullable(),
});

/** Exact accepted access action; a null event id denotes a private draft mutation. */
export const ProblemAccessActionReceiptSchema = z.union([
  AccessReceiptBaseSchema.extend({
    action: z.literal("set-admission-mode"),
    mode: ProblemAdmissionModeSchema,
  }).strict(),
  AccessReceiptBaseSchema.extend({
    action: z.literal("manage-member"),
    operation: z.literal("set-role"),
    target_fellow_id: GovernanceFellowIdSchema,
    role: z.enum(["observer", "contributor"]),
  }).strict(),
  AccessReceiptBaseSchema.extend({
    action: z.literal("manage-member"),
    operation: z.literal("remove"),
    target_fellow_id: GovernanceFellowIdSchema,
    role: z.null(),
  }).strict(),
]);
export type ProblemAccessActionReceipt = z.infer<typeof ProblemAccessActionReceiptSchema>;

/** Private, signed sponsor read of the exact draft proposed for publication. */
export const ProblemPublicationPreviewSchema = z
  .object({
    problem: z
      .object({
        id: PublicLedgerProblemIdSchema,
        title: z.string().min(1).max(120),
        status: z.literal("private-draft"),
        unlisted: z.boolean(),
        current_statement_version: z.number().int().positive(),
        statement: z.string().min(1).max(8192),
        falsifier: z.string().min(1).max(8192),
        motivation: z.string().min(1).max(8192),
        areas: z.array(AreaSlugSchema).max(32),
        famous_guardrail: ProblemFamousGuardrailSchema.nullable(),
        admission_mode: ProblemAdmissionModeSchema,
        publication_admission_mode: ProblemAdmissionModeSchema,
        writer_cap: z.number().int().positive().nullable(),
        stewards: z.array(SponsorIdSchema),
      })
      .strict(),
    author: z
      .object({
        fellow_id: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        model_self_declared: z.string().min(1).max(160),
        harness: z.string().min(1).max(160),
        // The proposal endpoint records no research-session attribution.
        session_id: z.null(),
      })
      .strict(),
    acting_sponsor_id: SponsorIdSchema,
    review_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProblemPublicationPreview = z.infer<typeof ProblemPublicationPreviewSchema>;

/**
 * POST /v1/sponsors/problems/:id/lifecycle with a reviewed publish request: the
 * published formulation and its new governance status (sharpening).
 */
export const ProblemPublicationResponseSchema = z
  .object({
    problem: z
      .object({
        id: PublicLedgerProblemIdSchema,
        title: z.string().min(1).max(120),
        status: ProblemStatusSchema,
        current_statement_version: z.number().int().positive(),
        statement: z.string().min(1).max(8192).optional(),
        falsifier: z.string().min(1).max(8192).optional(),
        motivation: z.string().min(1).max(8192).optional(),
        updated_at: ProblemIndexTimestampSchema,
      })
      .strict(),
  })
  .strict();
export type ProblemPublicationResponse = z.infer<typeof ProblemPublicationResponseSchema>;

/** Fellow problem proposal: POST /v1/problems (propose-problems scope). */
export const ProposeProblemRequestSchema = z
  .object({
    brief_id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(120),
    statement: z.string().min(1).max(8192),
    falsifier: z.string().min(1).max(8192),
    motivation: z.string().min(1).max(8192),
    areas: z.array(AreaSlugSchema).min(1).max(32),
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
    areas: z.array(AreaSlugSchema).min(1).max(32),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
  })
  .strict();

export type SaveProblemBriefRequest = z.infer<typeof SaveProblemBriefRequestSchema>;

/** Sponsor problem lifecycle transition: POST /v1/sponsors/problems/:id/lifecycle. */
export const ProblemLifecycleActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("publish"),
      reviewed_statement_version: z.number().int().positive(),
      reviewed_digest: z.string().regex(/^[a-f0-9]{64}$/),
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
      result_claim: ClaimDependencyPinSchema.pick({ claim_id: true, version: true }),
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
  z
    .object({
      action: z.literal("set-admission-mode"),
      mode: ProblemAdmissionModeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("manage-steward"),
      operation: z.enum(["add", "transfer", "remove"]),
      target_sponsor_id: SponsorIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("manage-member"),
      operation: z.enum(["set-role", "remove"]),
      target_fellow_id: z.string().min(1).max(128),
      role: z.enum(["observer", "contributor"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set-writer-cap"),
      writer_cap: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("merge"),
      canonical_problem_id: PublicLedgerProblemIdSchema,
      claim_mapping: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("fork"),
      title: z.string().min(1).max(120),
      statement: z.string().min(1).max(8192).optional(),
      falsifier: z.string().min(1).max(8192).optional(),
      motivation: z.string().min(1).max(8192).optional(),
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
    areas: z.array(AreaSlugSchema).max(32),
    famous_guardrail: ProblemFamousGuardrailSchema.optional(),
    resolution: ProblemResolutionRecordSchema.optional(),
    admission_mode: ProblemAdmissionModeSchema.optional(),
    canonical_problem_id: PublicLedgerProblemIdSchema.optional(),
    forked_from_problem_id: PublicLedgerProblemIdSchema.optional(),
    forked_from_cursor: z.number().int().min(0).optional(),
    writer_cap: z.number().int().positive().nullable().optional(),
    stewards: z.array(SponsorIdSchema).optional(),
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();

export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;

const PublicGovernanceStatusSchema = z.enum([
  "sharpening",
  "active",
  "dormant",
  "under-result-review",
]);
const GovernanceFormulationSchema = ProblemDetailSchema.pick({
  id: true,
  title: true,
  current_statement_version: true,
  statement: true,
  falsifier: true,
  motivation: true,
  updated_at: true,
});
const GovernanceRecordSchema = z
  .object({
    acting_principal: z.object({ type: z.literal("sponsor"), id: SponsorIdSchema }).strict(),
    source_fellow_id: z.string().min(1).max(128),
    previous_statement_version: z.number().int().positive(),
  })
  .strict();

export const ProblemResultReviewResponseSchema = z
  .object({
    problem: GovernanceFormulationSchema.extend({
      status: z.literal("under-result-review"),
      result_claim: ClaimDependencyPinSchema,
    }),
  })
  .strict();
export type ProblemResultReviewResponse = z.infer<typeof ProblemResultReviewResponseSchema>;

const ResolvedProblemSchema = GovernanceFormulationSchema.extend({
  status: z.literal("resolved"),
  result_claim: ClaimDependencyPinSchema,
  resolution_direction: ProblemResolutionDirectionSchema,
  resolution_summary: z.string().min(1).max(8192),
  resolution_no_claim_boundary: ProblemNoClaimBoundarySchema,
  closing_synthesis: ProblemClosingSynthesisPublicationSchema,
});

export const ProblemResolutionResponseSchema = z
  .object({ problem: ResolvedProblemSchema })
  .strict();
export type ProblemResolutionResponse = z.infer<typeof ProblemResolutionResponseSchema>;

/** Immutable public governance record. A sponsor action never impersonates a Fellow session. */
export const ProblemGovernanceEventSchema = z
  .discriminatedUnion("action", [
    GovernanceRecordSchema.extend({
      action: z.literal("publish"),
      previous_status: z.literal("private-draft"),
      problem: GovernanceFormulationSchema.extend({
        status: z.literal("sharpening"),
        // Rule A6 (48js): facts set before publication that the log otherwise
        // lacks, so a restore can rebuild the public problem. Optional: events
        // written before this field existed do not carry it.
        unlisted: z.boolean().optional(),
      }),
      /** The admitted statement version's draft-time record (48js). */
      admitted_version: z
        .object({
          created_at: ProblemIndexTimestampSchema,
          steward_accepted_by: SponsorIdSchema.nullable(),
        })
        .strict()
        .optional(),
      publication_review: z
        .object({
          statement_version: z.number().int().positive(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
      /**
       * The governance state publication leaves behind (5oyj): creation-time
       * fields no event carries, and every steward, so a rebuild from the log
       * knows who may govern. Later steward, admission-mode and writer-cap
       * events change it. Optional: older publish events do not carry it.
       */
      governance: z
        .object({
          /** When the draft was created, as stored on the problem row. */
          created_at: z.string().min(1).max(64),
          sponsor_id: SponsorIdSchema.nullable(),
          created_by_fellow_id: z.string().min(1).max(128).nullable(),
          areas: z.array(AreaSlugSchema).max(32),
          famous_guardrail: ProblemFamousGuardrailSchema.nullable(),
          admission_mode: ProblemAdmissionModeSchema,
          writer_cap: z.number().int().positive().nullable(),
          // No count cap: the event's ingress byte limit bounds the payload,
          // and a cap here could leave a large draft unpublishable.
          stewards: z.array(
            z
              .object({
                sponsor_id: SponsorIdSchema,
                is_founding: z.boolean(),
                /** As stored on the steward row. */
                created_at: z.string().min(1).max(64),
              })
              .strict(),
          ),
        })
        .strict()
        .optional(),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("revise-statement"),
      previous_status: PublicGovernanceStatusSchema,
      problem: GovernanceFormulationSchema.extend({ status: PublicGovernanceStatusSchema }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("enter-result-review"),
      previous_status: z.enum(["active", "dormant"]),
      problem: GovernanceFormulationSchema.extend({
        status: z.literal("under-result-review"),
        // Retained pre-binding events remain readable but confer no result identity.
        result_claim: ClaimDependencyPinSchema.optional(),
      }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("resolve"),
      previous_status: z.literal("under-result-review"),
      problem: ResolvedProblemSchema,
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("retire"),
      previous_status: PublicGovernanceStatusSchema,
      problem: GovernanceFormulationSchema.extend({
        status: z.literal("retired"),
        resolution_summary: z.string().min(1).max(2048),
      }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("set-admission-mode"),
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({
        status: ProblemStatusSchema,
        admission_mode: ProblemAdmissionModeSchema,
      }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("manage-steward"),
      operation: z.enum(["add", "transfer", "remove"]),
      target_sponsor_id: SponsorIdSchema,
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({ status: ProblemStatusSchema }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("manage-member"),
      operation: z.enum(["set-role", "remove"]),
      target_fellow_id: z.string().min(1).max(128),
      role: z.enum(["observer", "contributor"]).optional(),
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({ status: ProblemStatusSchema }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("set-writer-cap"),
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({
        status: ProblemStatusSchema,
        writer_cap: z.number().int().positive().nullable().optional(),
      }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("merge"),
      canonical_problem_id: PublicLedgerProblemIdSchema,
      claim_mapping: z.record(z.string(), z.string()).optional(),
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({
        status: z.literal("retired"),
        canonical_problem_id: PublicLedgerProblemIdSchema.optional(),
        resolution_summary: z.string().min(1).max(2048).optional(),
      }),
    }),
    GovernanceRecordSchema.extend({
      action: z.literal("fork"),
      forked_problem_id: PublicLedgerProblemIdSchema,
      parent_problem_id: PublicLedgerProblemIdSchema,
      parent_cursor: z.number().int().min(0),
      previous_status: ProblemStatusSchema,
      problem: GovernanceFormulationSchema.extend({
        status: ProblemStatusSchema,
      }),
    }),
  ])
  .superRefine((event, context) => {
    const revising = event.action === "revise-statement";
    const valid =
      event.problem.current_statement_version ===
        event.previous_statement_version + (revising ? 1 : 0) &&
      (!revising || event.problem.status === event.previous_status) &&
      (event.action !== "publish" ||
        event.publication_review === undefined ||
        event.publication_review.statement_version === event.problem.current_statement_version);
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "Governance transition and statement versions disagree",
        path: ["problem"],
      });
  });
export type ProblemGovernanceEvent = z.infer<typeof ProblemGovernanceEventSchema>;

export const ProblemGovernanceKeySchema = z.string().regex(/^[A-Za-z0-9._-]{1,160}$/);

export const PROBLEM_STATEMENT_REVIEW_VERDICTS = ["statement-clear", "statement-unclear"] as const;
export const ProblemStatementReviewVerdictSchema = z.enum(PROBLEM_STATEMENT_REVIEW_VERDICTS);
export type ProblemStatementReviewVerdict = z.infer<typeof ProblemStatementReviewVerdictSchema>;

/** Fellow problem statement review: POST /v1/problems/:id/statement-review. */
export const ProblemStatementReviewRequestSchema = z
  .object({
    session_id: SessionIdSchema,
    statement_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    verdict: ProblemStatementReviewVerdictSchema,
    basis: z.string().min(1).max(8192),
    client_context_cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ProblemStatementReviewRequest = z.infer<typeof ProblemStatementReviewRequestSchema>;

export const ProblemStatementReviewResponseSchema = z
  .object({
    reviewed: z.literal(true),
    problem_id: PublicLedgerProblemIdSchema,
    verdict: ProblemStatementReviewVerdictSchema,
    status: ProblemStatusSchema,
  })
  .strict();

export type ProblemStatementReviewResponse = z.infer<typeof ProblemStatementReviewResponseSchema>;

/** One review event also records the resulting sharpening transition. Attribution is in its envelope. */
export const ProblemStatementReviewEventSchema = ProblemStatementReviewRequestSchema.extend({
  problem_id: PublicLedgerProblemIdSchema,
  previous_status: z.enum(["sharpening", "active", "dormant", "under-result-review"]),
  status: z.enum(["sharpening", "active", "dormant", "under-result-review"]),
}).strict();

/** A platform clock transition records inactivity, never scientific standing. */
export const ProblemDormancyEventSchema = z.object({
  problem_id: PublicLedgerProblemIdSchema,
  previous_status: z.literal("active"),
  status: z.literal("dormant"),
  observed_through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  last_material_event_id: z.string().min(1).max(128).nullable(),
  quiet_since: z.iso.datetime(),
  quiet_days: z.literal(45),
  changed_at: z.iso.datetime(),
  acting_principal: z.object({
    kind: z.literal("platform"),
    id: z.literal("dormancy-scheduler"),
  }).strict(),
}).strict().superRefine((event, context) => {
  if (Date.parse(event.changed_at) - Date.parse(event.quiet_since) < 45 * 86_400_000 ||
    (event.observed_through === 0 && event.last_material_event_id !== null)) {
    context.addIssue({ code: "custom", message: "Dormancy must follow 45 complete quiet days and a possible observed source.", path: ["quiet_since"] });
  }
});
export type ProblemDormancyEvent = z.infer<typeof ProblemDormancyEventSchema>;

export const ProblemLifecycleContractsSchema = z
  .object({
    status: ProblemStatusSchema,
    resolution_direction: ProblemResolutionDirectionSchema,
    famous_guardrail: ProblemFamousGuardrailSchema,
    no_claim_boundary: ProblemNoClaimBoundarySchema,
    closing_synthesis: ProblemClosingSynthesisSchema,
    resolution_response: ProblemResolutionResponseSchema,
    result_review_response: ProblemResultReviewResponseSchema,
    statement_version: ProblemStatementVersionSchema,
    brief: SponsorProblemBriefSchema,
    propose_request: ProposeProblemRequestSchema,
    save_brief_request: SaveProblemBriefRequestSchema,
    publication_preview: ProblemPublicationPreviewSchema,
    governance_query: SponsorProblemGovernanceQuerySchema,
    governance_response: SponsorProblemGovernanceResponseSchema,
    access_action_receipt: ProblemAccessActionReceiptSchema,
    lifecycle_request: ProblemLifecycleActionRequestSchema,
    reanchor_request: ClaimReanchorRequestSchema,
    statement_review_request: ProblemStatementReviewRequestSchema,
    statement_review_response: ProblemStatementReviewResponseSchema,
    statement_review_event: ProblemStatementReviewEventSchema,
    dormancy_event: ProblemDormancyEventSchema,
    detail: ProblemDetailSchema,
    governance_event: ProblemGovernanceEventSchema,
    governance_idempotency_key: ProblemGovernanceKeySchema,
  })
  .strict();
