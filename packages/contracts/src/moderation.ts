import { z } from "zod";
import { ProblemSlowModeBudgetSchema, SponsorIdSchema } from "./enrollment.ts";
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

/** Public objects a report may name: the problem, a scientific object, or sponsor commentary. */
export const REPORT_TARGET_PATTERN =
  /^(?:problem|C-[0-9]+(?:@[1-9][0-9]{0,8})?|(?:H|E|R|G|L|DE|Q|CF|SYNTH)-[0-9A-Za-z-]{1,78}|COMM-[a-f0-9]{16,64})$/;

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

/** Private, bounded history for the sponsor accountable when a report was filed. */
export const SPONSOR_REPORTS_PAGE_LIMIT = 20;
export const SPONSOR_REPORTS_MAX_LIMIT = 50;
export const SPONSOR_REPORTS_MAX_RESPONSE_BYTES = 32 * 1024;
const ReportTimestampSchema = z.string().datetime({ precision: 3 });
export const SponsorReportsCursorSchema = z
  .object({
    created_at: ReportTimestampSchema,
    report_id: ReportResponseSchema.shape.report_id,
  })
  .strict();
export type SponsorReportsCursor = z.infer<typeof SponsorReportsCursorSchema>;
export const SponsorReportsRequestSchema = z
  .object({
    before: SponsorReportsCursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SPONSOR_REPORTS_MAX_LIMIT)
      .default(SPONSOR_REPORTS_PAGE_LIMIT),
  })
  .strict();
export type SponsorReportsRequest = z.infer<typeof SponsorReportsRequestSchema>;
export const SponsorReportSummarySchema = z
  .object({
    report_id: ReportResponseSchema.shape.report_id,
    problem_id: ProblemIdSchema,
    target: ReportRequestSchema.shape.target,
    reason: ReportReasonSchema,
    reporter_class: z.enum(["sponsor", "fellow"]),
    status: ReportResponseSchema.shape.status,
    created_at: ReportTimestampSchema,
    resolved_at: ReportTimestampSchema.nullable(),
  })
  .strict();
export type SponsorReportSummary = z.infer<typeof SponsorReportSummarySchema>;
export const SponsorReportsResponseSchema = z
  .object({
    schema: z.literal(REPORTS_SCHEMA_ID),
    sponsor_id: SponsorIdSchema,
    reports: z.array(SponsorReportSummarySchema).max(SPONSOR_REPORTS_MAX_LIMIT),
    has_more: z.boolean(),
    next_cursor: SponsorReportsCursorSchema.nullable(),
  })
  .strict();
export type SponsorReportsResponse = z.infer<typeof SponsorReportsResponseSchema>;

/** Bind an authenticated page to its request; reject incomplete or reordered readback. */
export function sponsorReportsMatchRequest(
  sponsorId: string,
  request: SponsorReportsRequest,
  page: SponsorReportsResponse,
): boolean {
  if (
    page.sponsor_id !== sponsorId ||
    page.reports.length > request.limit ||
    page.has_more !== (page.next_cursor !== null) ||
    (page.has_more && page.reports.length !== request.limit)
  )
    return false;
  let previous = request.before;
  const ids = new Set<string>();
  for (const report of page.reports) {
    if (
      ids.has(report.report_id) ||
      (report.status === "pending") !== (report.resolved_at === null) ||
      (previous !== undefined &&
        (report.created_at > previous.created_at ||
          (report.created_at === previous.created_at && report.report_id >= previous.report_id)))
    )
      return false;
    ids.add(report.report_id);
    previous = report;
  }
  const last = page.reports.at(-1);
  return (
    page.next_cursor === null ||
    (last !== undefined &&
      page.next_cursor.created_at === last.created_at &&
      page.next_cursor.report_id === last.report_id)
  );
}

/** Public moderation log actions, in quarantine notation. */
export const MODERATION_LOG_ACTIONS = [
  "published-with-warning",
  "quarantined",
  "released",
  "rejected",
  "hidden",
  "restored",
  "report-dismissed",
  "report-upheld",
  "sponsor-suspended",
] as const;

export const MODERATION_LOG_SUBJECTS = [
  "candidate",
  "ledger-object",
  "problem",
  "report",
  "sponsor",
] as const;

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

/** Fable §9.1: a temporary cap on new publication admissions, never a ban. */
export const PROBLEM_SLOW_MODE_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const PROBLEM_SLOW_MODE_STEP_UP_SECONDS = 15 * 60;
const SlowModeCommandFields = {
  /** Bind the concrete target into the signed service payload. */
  problem_id: ProblemIdSchema,
  expected_revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  reason: z.string().trim().min(10).max(1000),
  /** Stamped by the signed Agora service, never copied from a browser form. */
  step_up_authenticated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const ProblemSlowModeRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...SlowModeCommandFields,
      action: z.literal("set"),
      limit_per_hour: z.number().int().min(1).max(19),
      expires_at: z.string().datetime({ offset: true }).max(40),
    })
    .strict(),
  z.object({ ...SlowModeCommandFields, action: z.literal("clear") }).strict(),
]);
export type ProblemSlowModeRequest = z.infer<typeof ProblemSlowModeRequestSchema>;

const SlowModeReceiptFields = {
  problem_id: ProblemIdSchema,
  event_id: ProblemSlowModeBudgetSchema.shape.event_id,
  revision: ProblemSlowModeBudgetSchema.shape.revision,
  applied_at: z.string().datetime({ offset: true }).max(40),
};
export const ProblemSlowModeReceiptSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...SlowModeReceiptFields,
      action: z.literal("set"),
      limit_per_hour: z.number().int().min(1).max(19),
      expires_at: z.string().datetime({ offset: true }).max(40),
    })
    .strict(),
  z
    .object({
      ...SlowModeReceiptFields,
      action: z.literal("clear"),
      limit_per_hour: z.null(),
      expires_at: z.null(),
    })
    .strict(),
]);
export type ProblemSlowModeReceipt = z.infer<typeof ProblemSlowModeReceiptSchema>;

export const ProblemSlowModeStateSchema = z
  .object({
    problem_id: ProblemIdSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    effective_limit_per_hour: z.number().int().min(1).max(20),
    slow_mode: ProblemSlowModeBudgetSchema.extend({
      limit_per_hour: z.number().int().min(1).max(19),
      reason: z.string().min(10).max(1000),
      applied_at: z.string().datetime({ offset: true }).max(40),
    })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (state) =>
      state.slow_mode === null
        ? state.effective_limit_per_hour === 20
        : state.effective_limit_per_hour === state.slow_mode.limit_per_hour &&
          state.revision === state.slow_mode.revision,
    { message: "The visible budget must match the active control." },
  );
export type ProblemSlowModeState = z.infer<typeof ProblemSlowModeStateSchema>;

export const ModerationContractsSchema = z
  .object({
    report_request: ReportRequestSchema,
    report_response: ReportResponseSchema,
    sponsor_reports_request: SponsorReportsRequestSchema,
    sponsor_reports_response: SponsorReportsResponseSchema,
    moderation_log_response: ModerationLogResponseSchema,
    problem_slow_mode_request: ProblemSlowModeRequestSchema,
    problem_slow_mode_state: ProblemSlowModeStateSchema,
    problem_slow_mode_receipt: ProblemSlowModeReceiptSchema,
  })
  .strict();

/** The served `/schemas/reports.v1.json` document (inline, generated from Zod). */
export function generateReportsSchema(): string {
  return `${JSON.stringify(
    {
      $id: REPORTS_SCHEMA_ID,
      title: "ASImposium reports, moderation log and temporary problem limits",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        report_request: z.toJSONSchema(ReportRequestSchema),
        report_response: z.toJSONSchema(ReportResponseSchema),
        sponsor_reports_request: z.toJSONSchema(SponsorReportsRequestSchema),
        sponsor_reports_response: z.toJSONSchema(SponsorReportsResponseSchema),
        moderation_log_response: z.toJSONSchema(ModerationLogResponseSchema),
        problem_slow_mode_request: z.toJSONSchema(ProblemSlowModeRequestSchema),
        problem_slow_mode_state: z.toJSONSchema(ProblemSlowModeStateSchema),
        problem_slow_mode_receipt: z.toJSONSchema(ProblemSlowModeReceiptSchema),
      },
    },
    null,
    2,
  )}\n`;
}
