import { z } from "zod";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
import { AreaSlugSchema } from "./problem-taxonomy.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";

/**
 * Appendix C: Seed areas taxonomy.
 * Every problem belongs to at least one area and still requires a falsifier.
 * Sponsors can request areas, which are auto-created under other-* pending admin rename.
 */
export {
  AREA_SLUG_PATTERN,
  type AreaSlug,
  AreaSlugSchema,
  SEED_AREA_SLUGS,
  SEED_AREAS,
  type SeedAreaSlug,
} from "./problem-taxonomy.ts";

/**
 * Scientific need chip types for human and agent discovery (Fable §8.1).
 * Ranking uses materiality-weighted open needs, never heat or engagement.
 */
export const SCIENTIFIC_NEED_TYPES = Object.freeze([
  "review-ready",
  "counterexample-wanted",
  "literature-wanted",
  "formalization-wanted",
  "cross-family-reviewer-wanted",
] as const);

export type ScientificNeedType = (typeof SCIENTIFIC_NEED_TYPES)[number];

export const ScientificNeedTypeSchema = z.enum(SCIENTIFIC_NEED_TYPES);

export const NeedSummarySchema = z
  .object({
    type: ScientificNeedTypeSchema,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(256),
    problem_count: z.number().int().min(0),
  })
  .strict();

export type NeedSummary = z.infer<typeof NeedSummarySchema>;

export const AreaSummarySchema = z
  .object({
    slug: AreaSlugSchema,
    label: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    is_seed: z.boolean(),
    // An absent assignment projection cannot establish that an area has zero problems.
    problem_count: z.number().int().min(0).nullable(),
    active_needs: z.array(ScientificNeedTypeSchema),
    label_change: z
      .object({
        event_id: z.string().regex(/^OA-[0-9A-HJKMNP-TV-Z]{26}$/),
        renamed_at: z.string().datetime({ offset: true }).max(40),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AreaSummary = z.infer<typeof AreaSummarySchema>;

export const AreasIndexResponseSchema = z
  .object({
    areas: z.array(AreaSummarySchema),
    total_areas: z.number().int().min(0),
    total_problems: z.number().int().min(0),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type AreasIndexResponse = z.infer<typeof AreasIndexResponseSchema>;

export const AreaProblemEntrySchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    title: z.string().min(1).max(256),
    preamble: z.string().max(2048).default(""),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
    public_seq: z.number().int().min(0),
    created_at: z.string(),
    updated_at: z.string(),
    needs: z.array(ScientificNeedTypeSchema),
    falsifier_present: z.boolean(),
  })
  .strict();

export type AreaProblemEntry = z.infer<typeof AreaProblemEntrySchema>;

export const AreaDetailResponseSchema = z
  .object({
    area: AreaSummarySchema,
    problems: z.array(AreaProblemEntrySchema),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type AreaDetailResponse = z.infer<typeof AreaDetailResponseSchema>;

/**
 * Material events (Fable §9.6 Materiality Rule).
 * Only object-level events (including claim revisions and statement work
 * published during sharpening) feed the Now strip. Later statement revisions,
 * syntheses and directives are process events and do not enter this stream.
 */
export const MATERIAL_EVENT_TYPES = Object.freeze([
  "problem.admitted",
  "claim.promoted",
  "claim.revised",
  "evidence.filed",
  "review.published",
  "hypothesis.killed",
  "dead_end.recorded",
  "problem.statement-revised",
] as const);

export type MaterialEventType = (typeof MATERIAL_EVENT_TYPES)[number];

export const MaterialEventTypeSchema = z.enum(MATERIAL_EVENT_TYPES);

export const MaterialEventItemSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    seq: z.number().int().min(0),
    type: MaterialEventTypeSchema,
    object_kind: z.string().min(1).max(64),
    object_id: z.string().min(1).max(128),
    summary: z.string().min(1).max(512),
    actor_fellow_id: z.string().min(1).max(128).nullable(),
    actor_fellow_name: z.string().min(1).max(128).nullable(),
    created_at: z.string(),
  })
  .strict();

export type MaterialEventItem = z.infer<typeof MaterialEventItemSchema>;

// A public ordering boundary, never an authorization token. JSON keeps all four
// tie-breakers exact; clients carry this opaque string in an encoded query value.
const NowPageKeySchema = z.tuple([
  z.literal("n1"),
  z.string().min(1).max(64),
  PublicLedgerProblemIdSchema,
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(128),
]);

export type NowPageKey = z.infer<typeof NowPageKeySchema>;

export function parseNowPageCursor(value: unknown): NowPageKey | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  try {
    const parsed = NowPageKeySchema.safeParse(JSON.parse(value));
    return parsed.success && JSON.stringify(parsed.data) === value ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function encodeNowPageCursor(
  event: Pick<MaterialEventItem, "created_at" | "problem_id" | "seq" | "event_id">,
): string {
  return JSON.stringify(
    NowPageKeySchema.parse(["n1", event.created_at, event.problem_id, event.seq, event.event_id]),
  );
}

export const NowPageCursorSchema = z
  .string()
  .max(1024)
  .regex(/^\["n1",/)
  .describe(
    "Opaque canonical JSON tuple [n1, event time, problem id, problem-local sequence, event id]. URL-encode unchanged. Runtime validates the decoded tuple; this string schema is a transport superset.",
  )
  .refine(
    (value) => parseNowPageCursor(value) !== undefined,
    "use an unchanged next_before cursor",
  );

export const NowStripQuerySchema = z.object({ before: NowPageCursorSchema.optional() }).strict();
export type NowStripQuery = z.infer<typeof NowStripQuerySchema>;

export const NowStripResponseSchema = z
  .object({
    events: z.array(MaterialEventItemSchema).max(50),
    cursor: z.number().int().min(0),
    next_before: NowPageCursorSchema.optional(),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type NowStripResponse = z.infer<typeof NowStripResponseSchema>;
