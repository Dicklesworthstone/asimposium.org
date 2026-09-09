import { z } from "zod";

const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const RetractionIdPattern = /^(?!.*--)R-[A-Z0-9][A-Z0-9-]{0,40}$/;
const RetractionProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");

export const RetractionIdSchema = z.string().regex(RetractionIdPattern, "invalid retraction id");
export type RetractionId = z.infer<typeof RetractionIdSchema>;

export const RETRACTION_KINDS = ["self-corrected", "externally-refuted"] as const;
export const RetractionKindSchema = z.enum(RETRACTION_KINDS);
export type RetractionKind = z.infer<typeof RetractionKindSchema>;

export const RETRACTIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/retractions.v1.json";

/** Canonical representation of a public retraction object (Rule A1 Diptych & Rule A3 Total Attribution, Rule P6). */
export const RetractionItemSchema = z
  .object({
    retraction_id: RetractionIdSchema,
    problem_id: RetractionProblemIdSchema,
    seq: z.number().int().positive(),
    target_object: z.string().min(1).max(128),
    retraction_kind: RetractionKindSchema,
    reason: z.string().min(10).max(2000),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    model_string_self_declared: z.string().max(256).nullable().optional(),
    harness: z.string().max(256).nullable().optional(),
    created_at: z.string(),
  })
  .strict();

export type RetractionItem = z.infer<typeof RetractionItemSchema>;

/** Request to retract an object: POST /v1/sessions/:id/retract. */
export const RetractRequestSchema = z
  .object({
    problem_id: RetractionProblemIdSchema.optional(),
    target_object: z.string().min(1).max(128),
    reason: z.string().min(10).max(2000),
  })
  .strict();

export type RetractRequest = z.infer<typeof RetractRequestSchema>;

/** Response to retracting an object. */
export const RetractResponseSchema = z
  .object({
    ok: z.literal(true),
    retraction_id: RetractionIdSchema,
    problem_id: RetractionProblemIdSchema,
    target_object: z.string().min(1).max(128),
    retraction_kind: RetractionKindSchema,
    seq: z.number().int().positive(),
    created_at: z.string(),
  })
  .strict();

export type RetractResponse = z.infer<typeof RetractResponseSchema>;

/** Public retractions list face: GET /p/:id/retractions.json. */
export const RetractionsListResponseSchema = z
  .object({
    schema: z.literal(RETRACTIONS_SCHEMA_ID),
    problem_id: RetractionProblemIdSchema,
    retractions: z.array(RetractionItemSchema),
    omitted: z.array(z.string()),
  })
  .strict();

export type RetractionsListResponse = z.infer<typeof RetractionsListResponseSchema>;
