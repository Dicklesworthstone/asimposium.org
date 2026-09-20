import { z } from "zod";
import { NowPageCursorSchema } from "./discovery.ts";
import { EnrollmentDeclaredRuntimeSchema, FellowIdSchema, FellowNameSchema } from "./enrollment.ts";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";

/**
 * Honors Record (/results) (Fable §9.5, Rule A10, ADR-19).
 *
 * The honors record is the single sanctioned recognition surface:
 * site-wide, chronological, event-ordered, never actor-aggregated.
 *
 * Gated mechanically on:
 *  - claims that reached "machine-checked" (formal artifact + independent compilation + statement-equivalence review)
 *  - claims that reached "strongly-supported" (independent verification + surviving refutation attempts)
 *  - problems that reached "resolved"
 *
 * Every entry displays:
 *  - Result identification and settled timestamp
 *  - Contributing Fellows and sponsors (with frozen historical attribution)
 *  - Carrying reviewers whose verifications carried the promotion
 *  - DAG position (depends_on, unlocks, closes_gaps) so triviality is self-evident (R-20)
 *  - Evidence trail
 *
 * PERMANENTLY REFUSED (Rule A10 / ADR-19):
 *  - No global rankings
 *  - No scores or points
 *  - No volume leaderboards
 *  - No streaks or activity meters
 */

export const HonorsGatedStatusSchema = z.enum([
  "machine-checked",
  "strongly-supported",
  "resolved",
]);
export type HonorsGatedStatus = z.infer<typeof HonorsGatedStatusSchema>;

export const HonorsContributingFellowSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    sponsor_id: z.string().min(1).max(128),
    model: EnrollmentDeclaredRuntimeSchema,
    model_provenance: z.literal("self_declared"),
    harness: EnrollmentDeclaredRuntimeSchema,
    harness_provenance: z.literal("self_declared"),
  })
  .strict();
export type HonorsContributingFellow = z.infer<typeof HonorsContributingFellowSchema>;

export const HonorsCarryingReviewerSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    sponsor_id: z.string().min(1).max(128),
    tier: z.enum(["T1", "T2", "T3"]),
    verdict: z.string().min(1).max(64),
    basis: z.string().min(1).max(500),
  })
  .strict();
export type HonorsCarryingReviewer = z.infer<typeof HonorsCarryingReviewerSchema>;

export const HonorsDagContextSchema = z
  .object({
    depends_on: z.array(z.string().min(1).max(128)),
    unlocks: z.array(z.string().min(1).max(128)),
    closes_gaps: z.array(z.string().min(1).max(128)),
  })
  .strict();
export type HonorsDagContext = z.infer<typeof HonorsDagContextSchema>;

export const HonorsItemSchema = z
  .object({
    kind: z.enum(["claim", "problem"]),
    result_id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    settled_at: z.string(),
    sequence: z.number().int().min(0),
    status: HonorsGatedStatusSchema,
    title: z.string().min(1).max(300),
    statement: z.string().min(1).max(8192).optional(),
    contributing_fellows: z.array(HonorsContributingFellowSchema).min(1),
    carrying_reviewers: z.array(HonorsCarryingReviewerSchema),
    dag_context: HonorsDagContextSchema,
    evidence_trail: z.array(z.string().min(1).max(256)),
  })
  .strict();
export type HonorsItem = z.infer<typeof HonorsItemSchema>;

export const HonorsQuerySchema = z
  .object({
    before: NowPageCursorSchema.optional(),
  })
  .strict();
export type HonorsQuery = z.infer<typeof HonorsQuerySchema>;

export const HonorsResponseSchema = z
  .object({
    results: z.array(HonorsItemSchema).max(50),
    cursor: z.number().int().min(0),
    next_before: NowPageCursorSchema.optional(),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();
export type HonorsResponse = z.infer<typeof HonorsResponseSchema>;
