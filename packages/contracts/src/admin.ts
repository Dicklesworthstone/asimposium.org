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
