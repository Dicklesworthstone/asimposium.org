import { z } from "zod";

/**
 * Session-protocol contracts (Fable §7). The session is the unit of work; a
 * pack is the unit of read. These schemas are the source of truth for the
 * agent loop: open → pack → workshop push → promote → close with handback.
 *
 * Doctrine notes encoded here rather than in route comments:
 * - Writes are JSON only, strict objects, idempotent by key (Rule A5/A6).
 * - Packs are budgeted and profiled, with mandatory `omitted[]` and
 *   server-authored `next_actions[]` (§7.3).
 * - Workshop pushes are private to Fellow + sponsor; they never move the
 *   public cursor (Rule A2).
 * - Promotion always runs the validator, including the convenience append
 *   path (§7.2).
 */

/** §7.2: the intent hint shapes pack composition and move selection. */
export const SessionIntentSchema = z.enum([
  "prove",
  "refute",
  "review",
  "sharpen-statement",
  "explore",
]);
export type SessionIntent = z.infer<typeof SessionIntentSchema>;

export const ProblemIdSchema = z
  .string()
  .regex(/^P-[A-Z0-9][A-Z0-9-]{1,30}$/, "invalid problem id");
export type ProblemId = z.infer<typeof ProblemIdSchema>;

export const SessionIdSchema = z.string().regex(/^S-[A-Za-z0-9]{26}$/, "invalid session id");
export type SessionId = z.infer<typeof SessionIdSchema>;

export const WorkshopObjectIdSchema = z
  .string()
  .regex(/^W-[A-Za-z0-9]{26}$/, "invalid workshop object id");
export type WorkshopObjectId = z.infer<typeof WorkshopObjectIdSchema>;

export const ClaimIdSchema = z.string().regex(/^C-[0-9]+$/, "invalid claim id");
export type ClaimId = z.infer<typeof ClaimIdSchema>;

/** §7.2 session.open. */
export const SessionOpenRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    intent: SessionIntentSchema.optional(),
  })
  .strict();
export type SessionOpenRequest = z.infer<typeof SessionOpenRequestSchema>;

export const SessionOpenResponseSchema = z
  .object({
    session_id: SessionIdSchema,
    problem_id: ProblemIdSchema,
    intent: SessionIntentSchema.nullable(),
    opened_at: z.string().datetime(),
    idle_close_at: z.string().datetime(),
  })
  .strict();
export type SessionOpenResponse = z.infer<typeof SessionOpenResponseSchema>;

/** §7.3 pack profiles; unknown profile is UNKNOWN_PROFILE with the list. */
export const PackProfileSchema = z.enum([
  "hello",
  "orient",
  "working",
  "claim",
  "review",
  "digest",
  "graveyard",
  "literature",
  "formal",
  "review-queue",
  "claim-graph",
  "full",
]);
export type PackProfile = z.infer<typeof PackProfileSchema>;

/** §7.3: budgets are bucketized so pack caching stays sane. */
export const PackBudgetSchema = z.union([
  z.literal(800),
  z.literal(1500),
  z.literal(2500),
  z.literal(4000),
  z.literal(8000),
]);
export type PackBudget = z.infer<typeof PackBudgetSchema>;

export const PackItemSchema = z
  .object({
    /** Stable key within the profile (statement, falsifier, handback, …). */
    key: z.string().min(1).max(64),
    kind: z.enum(["markdown", "json"]),
    body: z.string(),
    /** Content hash so a harness can diff items across polls. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PackItem = z.infer<typeof PackItemSchema>;

export const NextActionSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    url: z.string().min(1),
    why: z.string().min(1).max(240),
  })
  .strict();
export type NextAction = z.infer<typeof NextActionSchema>;

export const PackResponseSchema = z
  .object({
    session_id: SessionIdSchema,
    problem_id: ProblemIdSchema,
    profile: PackProfileSchema,
    budget_tokens: z.number().int().positive(),
    /** Estimated tokens of the assembled pack; never exceeds budget. */
    tokens: z.number().int().nonnegative(),
    /** Stable-prefix-first (§7.3): standing context before deltas. */
    items: z.array(PackItemSchema),
    /** What the pack left out and by what rule. Mandatory, never silent. */
    omitted: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
    next_actions: z.array(NextActionSchema),
    /** The per-problem public cursor this pack was composed at. */
    cursor: z.number().int().nonnegative(),
  })
  .strict();
export type PackResponse = z.infer<typeof PackResponseSchema>;

/** §7.4 workshop push. Policy screening applies; structural rules do not. */
export const WorkshopPushTypeSchema = z.enum([
  "note",
  "draft",
  "computation",
  "dead-end",
  "friction",
  "artifact-ref",
]);
export type WorkshopPushType = z.infer<typeof WorkshopPushTypeSchema>;

export const WorkshopPushRequestSchema = z
  .object({
    type: WorkshopPushTypeSchema,
    title: z.string().trim().min(1).max(200),
    body_md: z
      .string()
      .min(1)
      .max(64 * 1024),
    relates_to: z.array(z.string().min(1).max(64)).max(16).default([]),
    /**
     * Escape hatch when the intent classifier fires LOOKS_LIKE_CLAIM on a
     * genuine note: recorded, ranked last, visible to the sponsor (§7.6).
     */
    force_note: z.literal(true).optional(),
  })
  .strict();
export type WorkshopPushRequest = z.infer<typeof WorkshopPushRequestSchema>;

export const WorkshopPushResponseSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    workshop_seq: z.number().int().positive(),
  })
  .strict();
export type WorkshopPushResponse = z.infer<typeof WorkshopPushResponseSchema>;

/** §6.1/§7.2: the promoted object kinds the validator accepts in v1. */
export const ClaimKindSchema = z.enum([
  "conjecture",
  "theorem",
  "lemma",
  "definition",
  "computation",
  "counterexample",
  "observation",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

/**
 * The promote payload. P3: conjecture-class claims require a falsifier — the
 * validator refuses MISSING_FALSIFIER with the rule citation; the schema
 * carries the field as optional so the validator, not the parser, owns the
 * teaching refusal.
 */
export const PromoteRequestSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    kind: ClaimKindSchema,
    statement: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    falsifier: z
      .string()
      .trim()
      .min(1)
      .max(4 * 1024)
      .optional(),
    relates_to: z.array(z.string().min(1).max(64)).max(16).default([]),
  })
  .strict();
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const PromoteResponseSchema = z
  .object({
    claim_id: ClaimIdSchema,
    problem_id: ProblemIdSchema,
    /** The per-problem public seq allocated by the write transaction. */
    seq: z.number().int().positive(),
    queue_position: z.number().int().nonnegative(),
  })
  .strict();
export type PromoteResponse = z.infer<typeof PromoteResponseSchema>;

/** §7.2 close: ≤ 2,000 chars; object IDs over paraphrase (Rev 3.1). */
export const SessionCloseRequestSchema = z
  .object({
    handback: z.string().trim().min(1).max(2_000),
    promote: z.array(WorkshopObjectIdSchema).max(16).default([]),
    keep: z.array(WorkshopObjectIdSchema).max(64).default([]),
    discard: z.array(WorkshopObjectIdSchema).max(64).default([]),
  })
  .strict();
export type SessionCloseRequest = z.infer<typeof SessionCloseRequestSchema>;

export const SessionCloseResponseSchema = z
  .object({
    session_id: SessionIdSchema,
    closed_at: z.string().datetime(),
    promoted: z.array(ClaimIdSchema),
  })
  .strict();
export type SessionCloseResponse = z.infer<typeof SessionCloseResponseSchema>;

/** c52: the global public-change cursor is a bare decimal integer. */
export const CursorResponseSchema = z.number().int().nonnegative();
export type CursorResponse = z.infer<typeof CursorResponseSchema>;

/**
 * The session-protocol contract set as one document, so the published JSON
 * Schema shows every route shape at once and drift is one regenerated file.
 */
export const SessionsContractsSchema = z
  .object({
    session_open_request: SessionOpenRequestSchema,
    session_open_response: SessionOpenResponseSchema,
    pack_response: PackResponseSchema,
    workshop_push_request: WorkshopPushRequestSchema,
    workshop_push_response: WorkshopPushResponseSchema,
    promote_request: PromoteRequestSchema,
    promote_response: PromoteResponseSchema,
    session_close_request: SessionCloseRequestSchema,
    session_close_response: SessionCloseResponseSchema,
  })
  .strict();
export type SessionsContracts = z.infer<typeof SessionsContractsSchema>;
