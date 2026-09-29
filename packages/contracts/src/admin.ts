import { z } from "zod";
import {
  ScreeningCoarseCategorySchema,
  ScreeningDecisionPathSchema,
  ScreeningDigestSchema,
  ScreeningProviderStatusSchema,
  ScreeningReviewStateSchema,
  ScreeningVersionIdentifierSchema,
} from "./screening.ts";

export const ADMIN_TARGET_KINDS = ["problem", "claim", "commentary", "sponsor"] as const;
export const AdminTargetKindSchema = z.enum(ADMIN_TARGET_KINDS);
export type AdminTargetKind = z.infer<typeof AdminTargetKindSchema>;

export const ADMIN_CONTENT_ACTIONS = ["hide", "restore", "ban_sponsor"] as const;
export const AdminContentActionSchema = z.enum(ADMIN_CONTENT_ACTIONS);
export type AdminContentAction = z.infer<typeof AdminContentActionSchema>;

export const ADMIN_QUARANTINE_DECISIONS = ["release", "confirm_rejection"] as const;
export const AdminQuarantineDecisionSchema = z.enum(ADMIN_QUARANTINE_DECISIONS);
export type AdminQuarantineDecision = z.infer<typeof AdminQuarantineDecisionSchema>;

export const ADMIN_REPORT_STATUSES = ["pending", "dismissed", "upheld"] as const;
export const AdminReportStatusSchema = z.enum(ADMIN_REPORT_STATUSES);
export type AdminReportStatus = z.infer<typeof AdminReportStatusSchema>;

/**
 * Quarantine item representation for the operator admin queue.
 * Provenance is included; body, detector prompt, raw regex patterns, scores,
 * and hidden reasoning are excluded (Rule A5/A11 / Fable §7.7 / ADR-18).
 */
export const AdminQuarantineItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    target_id: z.string().min(1).max(128),
    created_at: z.string().datetime({ offset: true }).max(40),
    coarse_category: ScreeningCoarseCategorySchema,
    decision_path: ScreeningDecisionPathSchema,
    provider_status: ScreeningProviderStatusSchema,
    input_digest: ScreeningDigestSchema,
    context_frontier_digest: ScreeningDigestSchema,
    model_version: ScreeningVersionIdentifierSchema,
    policy_version: ScreeningVersionIdentifierSchema,
    configuration_digest: ScreeningDigestSchema,
    reviewer_state: ScreeningReviewStateSchema,
    appeal_status: z.enum(["none", "pending", "adjudicated"]).default("none"),
  })
  .strict();
export type AdminQuarantineItem = z.infer<typeof AdminQuarantineItemSchema>;

export const AdminQuarantineQueueResponseSchema = z
  .object({
    items: z.array(AdminQuarantineItemSchema),
    total_pending: z.number().int().nonnegative(),
  })
  .strict();
export type AdminQuarantineQueueResponse = z.infer<typeof AdminQuarantineQueueResponseSchema>;

export const AdminQuarantineDecisionRequestSchema = z
  .object({
    case_id: z.string().min(1).max(128),
    decision: AdminQuarantineDecisionSchema,
    reason: z.string().min(10).max(1000),
  })
  .strict();
export type AdminQuarantineDecisionRequest = z.infer<typeof AdminQuarantineDecisionRequestSchema>;

export const AdminQuarantineDecisionResponseSchema = z
  .object({
    ok: z.literal(true),
    case_id: z.string().min(1).max(128),
    decision: AdminQuarantineDecisionSchema,
    audit_event_id: z.string().min(1).max(128),
    decided_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type AdminQuarantineDecisionResponse = z.infer<typeof AdminQuarantineDecisionResponseSchema>;

/**
 * Content control request for hide/restore/ban actions.
 * Explicitly rejects any disposition override or event rewrite.
 */
export const AdminContentControlRequestSchema = z
  .object({
    target_id: z.string().min(1).max(128),
    target_kind: AdminTargetKindSchema,
    action: AdminContentActionSchema,
    reason: z.string().min(10).max(1000),
  })
  .strict();
export type AdminContentControlRequest = z.infer<typeof AdminContentControlRequestSchema>;

export const AdminContentControlResponseSchema = z
  .object({
    ok: z.literal(true),
    target_id: z.string().min(1).max(128),
    action: AdminContentActionSchema,
    audit_event_id: z.string().min(1).max(128),
    applied_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type AdminContentControlResponse = z.infer<typeof AdminContentControlResponseSchema>;

export const AdminReportItemSchema = z
  .object({
    report_id: z.string().min(1).max(128),
    target_id: z.string().min(1).max(128),
    target_kind: AdminTargetKindSchema,
    created_at: z.string().datetime({ offset: true }).max(40),
    reporter_class: z.enum(["fellow", "sponsor", "anonymous", "sentinel"]),
    category: ScreeningCoarseCategorySchema,
    status: AdminReportStatusSchema,
  })
  .strict();
export type AdminReportItem = z.infer<typeof AdminReportItemSchema>;

export const AdminReportsQueueResponseSchema = z
  .object({
    reports: z.array(AdminReportItemSchema),
    total_pending: z.number().int().nonnegative(),
  })
  .strict();
export type AdminReportsQueueResponse = z.infer<typeof AdminReportsQueueResponseSchema>;

export const AdminReportResolutionRequestSchema = z
  .object({
    report_id: z.string().min(1).max(128),
    resolution: z.enum(["dismiss", "uphold"]),
    reason: z.string().min(10).max(1000),
  })
  .strict();
export type AdminReportResolutionRequest = z.infer<typeof AdminReportResolutionRequestSchema>;

export const AdminReportResolutionResponseSchema = z
  .object({
    ok: z.literal(true),
    report_id: z.string().min(1).max(128),
    resolution: z.enum(["dismiss", "uphold"]),
    audit_event_id: z.string().min(1).max(128),
    resolved_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type AdminReportResolutionResponse = z.infer<typeof AdminReportResolutionResponseSchema>;

export const AdminAreaRenameRequestSchema = z
  .object({
    area_id: z.string().min(1).max(128),
    new_title: z.string().min(2).max(120),
    reason: z.string().min(10).max(1000),
  })
  .strict();
export type AdminAreaRenameRequest = z.infer<typeof AdminAreaRenameRequestSchema>;

export const AdminAreaRenameResponseSchema = z
  .object({
    ok: z.literal(true),
    area_id: z.string().min(1).max(128),
    new_title: z.string().min(2).max(120),
    audit_event_id: z.string().min(1).max(128),
    renamed_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type AdminAreaRenameResponse = z.infer<typeof AdminAreaRenameResponseSchema>;

export const AdminAuditEventSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    timestamp: z.string().datetime({ offset: true }).max(40),
    operator_id: z.string().min(1).max(128),
    action: z.string().min(1).max(64),
    target_id: z.string().min(1).max(128),
    reason: z.string().min(1).max(1000),
    before_state_digest: ScreeningDigestSchema.optional(),
    after_state_digest: ScreeningDigestSchema.optional(),
  })
  .strict();
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;

export const AdminAuditHistoryResponseSchema = z
  .object({
    events: z.array(AdminAuditEventSchema),
  })
  .strict();
export type AdminAuditHistoryResponse = z.infer<typeof AdminAuditHistoryResponseSchema>;

/**
 * Structural impossibility of scientific disposition overrides (Fable §3 / Rule A4 / W8.8c).
 * Admin tools can apply moderation visibility flags (hide, restore, ban, quarantine decision)
 * but CANNOT set, alter, or waive a scientific disposition or rewrite a ledger event.
 */
/**
 * W2.6 ops:projection-rebuild (Rule A6): the projection tables the doctor
 * rebuilds from a problem's event log, in repair (insert) order. The Worker's
 * replay module must replay exactly these.
 */
export const PROJECTION_DOCTOR_TABLES = [
  "claims",
  "claim_projections",
  "claim_versions",
  "claim_deps",
  "reviews",
  "evidence",
  "hypotheses",
  "dead_ends",
  "questions",
  "retractions",
  "citations",
  "citation_versions",
  "proof_gaps",
  "conflicts",
  "syntheses",
  "claim_relations",
] as const;
export const ProjectionDoctorTableSchema = z.enum(PROJECTION_DOCTOR_TABLES);

/** At most this many drift items are listed; `drift_truncated` says when more exist. */
export const MAX_PROJECTION_DOCTOR_DRIFT_ITEMS = 200;

const ProjectionDriftItemSchema = z
  .object({
    table: ProjectionDoctorTableSchema,
    /** The row's primary key (public ledger identifiers joined by "@"), never row content. */
    key: z.string().min(1).max(512),
    kind: z.enum(["missing_row", "orphan_row", "column"]),
    column: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
  })
  .strict()
  .refine((item) => (item.kind === "column") === (item.column !== undefined), {
    message: "column names appear exactly on column drift",
  });

/**
 * The dry-run report of `GET /v1/operators/problems/:problemId/projections`.
 * Counts, keys and column names only: no event payload or row content.
 */
export const ProjectionDoctorReportSchema = z
  .object({
    problem_id: z.string().min(1).max(128),
    mode: z.literal("dry-run"),
    /** The last event sequence the replay read (0 for an empty log). */
    source_cursor: z.number().int().nonnegative(),
    /** log_integrity_failed takes precedence: nothing is rebuilt from an unverified log. */
    status: z.enum([
      "consistent",
      "drift",
      "unreplayable",
      "log_integrity_failed",
      // Events without their v2 chain digests yet (integrity backfill pending):
      // the log cannot be verified, which is not evidence of tampering.
      "log_unverifiable",
    ]),
    tables: z
      .array(
        z
          .object({
            table: ProjectionDoctorTableSchema,
            rebuilt_rows: z.number().int().nonnegative(),
            live_rows: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(PROJECTION_DOCTOR_TABLES.length),
    drift: z.array(ProjectionDriftItemSchema).max(MAX_PROJECTION_DOCTOR_DRIFT_ITEMS),
    drift_count: z.number().int().nonnegative(),
    drift_truncated: z.boolean(),
    /** Events a replayed table needs whose payload is unavailable (redacted). */
    unreplayable_events: z.number().int().nonnegative(),
    /**
     * ops:event-verify over the same problem: the envelope chain, every
     * unredacted payload against its digest, and the latest checkpoint root.
     */
    integrity: z
      .object({
        events: z.number().int().nonnegative(),
        chain_sound: z.boolean(),
        /** Some events still lack their v2 chain digests (backfill pending). */
        backfill_pending: z.boolean(),
        /**
         * The problem head (public cursor and chain digest) names the last
         * event, so no tail was removed. True for a problem with no events.
         */
        head_matches: z.boolean(),
        /** Events whose stored payload does not hash to its recorded digest (or is missing). */
        content_mismatches: z.number().int().nonnegative(),
        /** Lawfully redacted payloads: digest kept, bytes not checkable. */
        redacted: z.number().int().nonnegative(),
        checkpoint: z
          .object({
            seq: z.number().int().positive(),
            matches: z.boolean(),
          })
          .strict()
          .nullable(),
        sound: z.boolean(),
      })
      .strict(),
    /**
     * True exactly when the log verifies, nothing is unreplayable and every
     * drift item is a missing row.
     */
    repairable: z.boolean(),
  })
  .strict();
export type ProjectionDoctorReport = z.infer<typeof ProjectionDoctorReportSchema>;

/** `POST /v1/operators/problems/:problemId/projections/repair`: inserts missing rows only. */
export const ProjectionRepairResponseSchema = z
  .object({
    problem_id: z.string().min(1).max(128),
    mode: z.literal("repair"),
    source_cursor: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    status: z.literal("consistent"),
  })
  .strict();
export type ProjectionRepairResponse = z.infer<typeof ProjectionRepairResponseSchema>;

export class ScientificDispositionOverrideProhibitedError extends Error {
  readonly code = "SCIENTIFIC_DISPOSITION_OVERRIDE_PROHIBITED";
  constructor(message = "Admin cannot directly set a scientific disposition or rewrite an event.") {
    super(message);
    this.name = "ScientificDispositionOverrideProhibitedError";
  }
}

export function assertNoScientificDispositionOverride(payload: Record<string, unknown>): void {
  if (
    "disposition" in payload ||
    "scientific_disposition" in payload ||
    "claim_disposition" in payload ||
    "status_override" in payload
  ) {
    throw new ScientificDispositionOverrideProhibitedError();
  }
}
