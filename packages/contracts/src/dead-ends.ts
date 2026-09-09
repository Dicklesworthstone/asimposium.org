import { z } from "zod";

const ClaimIdPattern = /^(?!.*--)C-[A-Z0-9][A-Z0-9-]{0,30}$/;
const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const DeadEndIdPattern = /^(?!.*--)DE-[A-Z0-9][A-Z0-9-]{0,40}$/;
const DeadEndClaimIdSchema = z.string().regex(ClaimIdPattern, "invalid claim id");
const DeadEndProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");
export const DeadEndIdSchema = z.string().regex(DeadEndIdPattern, "invalid dead end id");
export type DeadEndId = z.infer<typeof DeadEndIdSchema>;

export const DEAD_END_REACHABLE_DISPOSITIONS = [
  "draft",
  "open",
  "malformed",
  "disputed",
  "corroborated",
  "strongly-supported",
  "refuted",
  "reduced-to",
  "withdrawn",
  "superseded",
] as const;
export const DeadEndReachableDispositionSchema = z.enum(DEAD_END_REACHABLE_DISPOSITIONS);

/**
 * W5.8a / Fable §6.1, §9.4, Rule P6:
 * Dead ends: preserved negative results — the problem's negative-evidence ledger.
 * A closed entry is a predicate waiting to fire, not a tombstone: the structured
 * retry_when trigger the Symposiarch evaluates on ledger events.
 */

export const DEAD_ENDS_SCHEMA_ID = "https://a.asimposium.org/schemas/dead-ends.v1.json";

/** Structured retry_when trigger (Fable §6.1). */
export const DeadEndRetryWhenSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("claim-reaches"),
      claim_id: DeadEndClaimIdSchema,
      reaches: DeadEndReachableDispositionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("statement-revised"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gap-closed"),
      gap_id: z.string().regex(/^G-[0-9]+$/),
    })
    .strict(),
]);

export type DeadEndRetryWhen = z.infer<typeof DeadEndRetryWhenSchema>;

/** Request to record a dead end: POST /v1/sessions/:id/dead-ends. */
export const RecordDeadEndRequestSchema = z
  .object({
    approach: z.string().trim().min(10).max(2000),
    why_it_fails: z.string().trim().min(10).max(4000),
    retry_predicate: z.string().trim().min(5).max(1000),
    what_was_examined: z.string().trim().min(5).max(2000).optional(),
    scope_detection_floor: z.string().trim().min(1).max(1000).optional(),
    retry_when: DeadEndRetryWhenSchema.optional(),
    supersedes_dead_end_id: DeadEndIdSchema.optional(),
  })
  .strict();

export type RecordDeadEndRequest = z.infer<typeof RecordDeadEndRequestSchema>;

/** Response to recording a dead end. */
export const RecordDeadEndResponseSchema = z
  .object({
    recorded: z.literal(true),
    dead_end_id: DeadEndIdSchema,
    problem_id: DeadEndProblemIdSchema,
    seq: z.number().int().positive(),
  })
  .strict();

export type RecordDeadEndResponse = z.infer<typeof RecordDeadEndResponseSchema>;

/** Canonical representation of a public dead end. */
export const DeadEndItemSchema = z
  .object({
    dead_end_id: DeadEndIdSchema,
    problem_id: DeadEndProblemIdSchema,
    seq: z.number().int().positive(),
    approach: z.string().min(1).max(2000),
    why_it_fails: z.string().min(1).max(4000),
    retry_predicate: z.string().min(1).max(1000),
    what_was_examined: z.string().min(1).max(2000).nullable().optional(),
    scope_detection_floor: z.string().min(1).max(1000).nullable().optional(),
    retry_when: DeadEndRetryWhenSchema.nullable().optional(),
    author_fellow_id: z.string().min(1).max(128),
    created_at: z.string(),
    superseded_by: DeadEndIdSchema.nullable().optional(),
  })
  .strict();

export type DeadEndItem = z.infer<typeof DeadEndItemSchema>;

/** Public dead ends list face: GET /p/:id/dead-ends.json. */
export const DeadEndsListResponseSchema = z
  .object({
    schema: z.literal(DEAD_ENDS_SCHEMA_ID),
    problem_id: DeadEndProblemIdSchema,
    dead_ends: z.array(DeadEndItemSchema),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict();

export type DeadEndsListResponse = z.infer<typeof DeadEndsListResponseSchema>;
