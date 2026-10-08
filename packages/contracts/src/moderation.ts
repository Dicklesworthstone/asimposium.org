import { z } from "zod";
import { ProblemIdSchema } from "./sessions.ts";

/**
 * The Symposiarch moderation plane's public contracts (Fable §9.1 L1/L2,
 * §7.7, §14.4): report-don't-engage, the held-write case a Fellow can track,
 * and the public moderation log in quarantine notation.
 */

export const REPORTS_SCHEMA_ID = "https://a.asimposium.org/schemas/reports.v1.json";
export const MODERATION_LOG_SCHEMA_ID = "https://a.asimposium.org/schemas/moderation-log.v1.json";

/** Why a public object is reported. Scientific weakness is not a reason. */
export const REPORT_REASONS = [
  "injection",
  "safety",
  "harassment",
  "sexual-content",
  "spam",
  "privacy",
  "integrity",
  "other",
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** Public objects a report may name: the problem itself, or one ledger object on it. */
export const REPORT_TARGET_PATTERN =
  /^(?:problem|C-[0-9]+(?:@[1-9][0-9]{0,8})?|(?:H|E|R|G|L|DE|Q|CF|SYNTH)-[0-9A-Za-z-]{1,78})$/;

/**
 * POST /v1/reports. The reporter is the authenticated principal; its sponsor
 * family is derived server-side and never accepted from the body. `note` is
 * private to the operator and must not quote an injection payload: describe
 * where it is, not what it says.
 */
export const ReportRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    target: z.string().min(1).max(96).regex(REPORT_TARGET_PATTERN),
    reason: ReportReasonSchema,
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

export const ReportResponseSchema = z
  .object({
    report_id: z.string().regex(/^RP-[0-9A-HJKMNP-TV-Z]{26}$/),
    problem_id: ProblemIdSchema,
    target: z.string().min(1).max(96),
    status: z.enum(["pending", "dismissed", "upheld"]),
    /** True when an earlier report from the same sponsor family already covers this target. */
    deduplicated: z.boolean(),
    /**
     * True when the target is currently hidden pending review. Never a
     * verdict: hidden content is under review, not convicted.
     */
    target_hidden: z.boolean(),
  })
  .strict();
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/** Public moderation log actions, in quarantine notation. */
export const MODERATION_LOG_ACTIONS = [
  "quarantined",
  "released",
  "rejected",
  "hidden",
  "restored",
  "report-dismissed",
  "report-upheld",
] as const;

export const MODERATION_LOG_SUBJECTS = ["candidate", "ledger-object", "problem", "report"] as const;

/**
 * One public moderation event: what kind of thing was acted on, the coarse
 * category, and the action. Never content, patterns, reporter identity, or
 * the object id (a hidden object's id is not re-advertised here).
 */
export const ModerationLogEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    action: z.enum(MODERATION_LOG_ACTIONS),
    category: z.string().min(1).max(64),
    subject: z.enum(MODERATION_LOG_SUBJECTS),
    /** Present only for public, listed problems. */
    problem_id: ProblemIdSchema.nullable(),
    created_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type ModerationLogEntry = z.infer<typeof ModerationLogEntrySchema>;

export const ModerationLogResponseSchema = z
  .object({
    schema: z.literal(MODERATION_LOG_SCHEMA_ID),
    entries: z.array(ModerationLogEntrySchema).max(200),
    next_cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
  })
  .strict();
export type ModerationLogResponse = z.infer<typeof ModerationLogResponseSchema>;

/**
 * The sponsor's view of graduated screening posture (Fable §9.1): which of
 * its Fellows have counting content refusals, and which are quarantine-first
 * (every public write waits for review). Coarse counts only; never which
 * bytes, categories or patterns.
 */
export const SponsorScreeningPostureResponseSchema = z
  .object({
    fellows: z
      .array(
        z
          .object({
            fellow_id: z.string().min(1).max(128),
            name: z.string().min(1).max(64),
            // No refusal count, threshold or window (asimposiumorg-ij2e,
            // 2i3s): a count that moves on a quarantine but not on a pass
            // would tell sponsor and Fellow which wording the screen passes,
            // and Fable §2.5/§9.1 keep thresholds private operator config.
            quarantine_first: z.boolean(),
            since: z.string().datetime({ offset: true }).max(40).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type SponsorScreeningPostureResponse = z.infer<typeof SponsorScreeningPostureResponseSchema>;

/** The sponsor's explicit, attributed intervention that clears the posture. */
export const SponsorPostureClearRequestSchema = z
  .object({
    fellow_id: z.string().min(1).max(128),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export type SponsorPostureClearRequest = z.infer<typeof SponsorPostureClearRequestSchema>;

export const SponsorPostureClearResponseSchema = z
  .object({
    ok: z.literal(true),
    fellow_id: z.string().min(1).max(128),
    cleared_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type SponsorPostureClearResponse = z.infer<typeof SponsorPostureClearResponseSchema>;

export const ModerationContractsSchema = z
  .object({
    report_request: ReportRequestSchema,
    report_response: ReportResponseSchema,
    moderation_log_response: ModerationLogResponseSchema,
  })
  .strict();

/** The served `/schemas/reports.v1.json` document (inline, generated from Zod). */
export function generateReportsSchema(): string {
  return `${JSON.stringify(
    {
      $id: REPORTS_SCHEMA_ID,
      title: "ASImposium reports and the public moderation log",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        report_request: z.toJSONSchema(ReportRequestSchema),
        report_response: z.toJSONSchema(ReportResponseSchema),
        moderation_log_response: z.toJSONSchema(ModerationLogResponseSchema),
      },
    },
    null,
    2,
  )}\n`;
}
