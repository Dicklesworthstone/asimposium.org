import { z } from "zod";

const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const ConflictIdPattern = /^(?!.*--)CF-[A-Z0-9][A-Z0-9-]{0,40}$/;
const ClaimIdPattern = /^(?!.*--)C-[A-Z0-9][A-Z0-9-]{0,40}$/;

const ConflictProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");

export const ConflictIdSchema = z.string().regex(ConflictIdPattern, "invalid conflict id");
export type ConflictId = z.infer<typeof ConflictIdSchema>;

export const CONFLICT_STATUSES = ["open", "resolved", "persistent-uncertainty"] as const;
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

export const CONFLICTS_SCHEMA_ID = "https://a.asimposium.org/schemas/conflicts.v1.json";

/** Exact-version pin for a conflicting claim (Fable §6.1, ADR-21). */
export const ConflictingClaimRefSchema = z
  .object({
    claim_id: z.string().regex(ClaimIdPattern, "invalid claim id"),
    version: z.number().int().min(1),
  })
  .strict();
export type ConflictingClaimRef = z.infer<typeof ConflictingClaimRefSchema>;

/** Canonical representation of a public conflict object CF-n (Rule A1 Diptych & Rule A3 Total Attribution). */
export const ConflictItemSchema = z
  .object({
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    seq: z.number().int().positive(),
    claims: z.array(ConflictingClaimRefSchema).min(2).max(2),
    aligned_definitions: z.string().min(1).max(4000),
    aligned_scope: z.string().min(1).max(4000),
    aligned_quantifiers: z.string().min(1).max(4000),
    smallest_disagreement: z.string().min(1).max(2000),
    agreed_facts: z.array(z.string().min(1).max(1000)).min(1).max(32),
    discriminating_tests: z.array(z.string().min(1).max(1000)).min(1).max(32),
    status: ConflictStatusSchema,
    resolution: z.string().min(1).max(4000).nullable().optional(),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    created_at: z.string(),
    resolved_at: z.string().nullable().optional(),
  })
  .strict();

export type ConflictItem = z.infer<typeof ConflictItemSchema>;

/** Request to normalize and open an apparent conflict: POST /v1/sessions/:id/conflicts. */
export const NormalizeConflictRequestSchema = z
  .object({
    problem_id: ConflictProblemIdSchema.optional(),
    claims: z.array(ConflictingClaimRefSchema).min(2).max(2),
    aligned_definitions: z.string().trim().min(10).max(4000),
    aligned_scope: z.string().trim().min(10).max(4000),
    aligned_quantifiers: z.string().trim().min(10).max(4000),
    smallest_disagreement: z.string().trim().min(10).max(2000),
    agreed_facts: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
    discriminating_tests: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.claims[0]?.claim_id === value.claims[1]?.claim_id) {
      ctx.addIssue({
        code: "custom",
        path: ["claims"],
        message: "conflicting claims must refer to distinct claim IDs",
      });
    }
  });

export type NormalizeConflictRequest = z.infer<typeof NormalizeConflictRequestSchema>;

/** Response to normalizing a conflict. */
export const NormalizeConflictResponseSchema = z
  .object({
    ok: z.literal(true),
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    status: z.literal("open"),
    seq: z.number().int().positive(),
    created_at: z.string(),
  })
  .strict();

export type NormalizeConflictResponse = z.infer<typeof NormalizeConflictResponseSchema>;

/** Request to resolve a conflict: POST /v1/sessions/:id/conflicts/:cid/resolve. */
export const ResolveConflictRequestSchema = z
  .object({
    status: z.enum(["resolved", "persistent-uncertainty"]),
    resolution: z.string().trim().min(10).max(4000),
  })
  .strict();

export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;

/** Response to resolving a conflict. */
export const ResolveConflictResponseSchema = z
  .object({
    ok: z.literal(true),
    conflict_id: ConflictIdSchema,
    problem_id: ConflictProblemIdSchema,
    status: z.enum(["resolved", "persistent-uncertainty"]),
    seq: z.number().int().positive(),
    resolved_at: z.string(),
  })
  .strict();

export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponseSchema>;

/** Public conflicts list face: GET /p/:id/conflicts.json. */
export const ConflictsListResponseSchema = z
  .object({
    schema: z.literal(CONFLICTS_SCHEMA_ID),
    problem_id: ConflictProblemIdSchema,
    conflicts: z.array(ConflictItemSchema),
    omitted: z.array(z.string()),
  })
  .strict();

export type ConflictsListResponse = z.infer<typeof ConflictsListResponseSchema>;
