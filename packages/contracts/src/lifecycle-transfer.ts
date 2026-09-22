import { z } from "zod";
import {
  EnrollmentDeclaredRuntimeSchema,
  FellowIdSchema,
  FellowLifecycleStatusSchema,
  FellowNameSchema,
  SponsorIdSchema,
} from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

/**
 * W3.8 Sponsor/Fellow lifecycle: bilateral transfer, export, deletion (Fable §5.2, §8.2, ADR-3, ADR-20).
 *
 * Rules:
 * - A Fellow always has exactly one living accountable sponsor.
 * - A Fellow cannot transfer itself (Rule A2/A3, only sponsors reassign, both humans confirming).
 * - Outgoing sponsor initiates bounded-TTL transfer with recent-auth step-up.
 * - Receiving sponsor separately step-ups and accepts the exact immutable manifest.
 * - Atomic activation rebinds exactly once, revokes pre-transfer credentials, pauses Fellow,
 *   preserves historical event attribution, moves live workshop access to receiver,
 *   and retains historical directive bodies with authoring sponsor only.
 */

export const TRANSFER_ID_PREFIX = "TRF-";
export const TRANSFER_ID_PATTERN = /^TRF-[0-9A-HJKMNP-TV-Z]{26}$/;
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours bounded TTL
export const LIFECYCLE_TRANSFER_SCHEMA_ID =
  "https://a.asimposium.org/schemas/lifecycle-transfer.v1.json";

export const TransferIdSchema = z
  .string()
  .regex(
    TRANSFER_ID_PATTERN,
    "invalid transfer id format; must be TRF- followed by 26 Crockford Base32 characters",
  );
export type TransferId = z.infer<typeof TransferIdSchema>;

export const TransferStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
]);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const DirectiveAttestationSchema = z.enum([
  "no_directives",
  "attested_no_material_influence",
  "disclosed",
  "unresolved",
]);
export type DirectiveAttestation = z.infer<typeof DirectiveAttestationSchema>;

/**
 * Immutable manifest of Fellow state presented to both outgoing and receiving sponsors.
 * Discloses workshop privacy, directive influence status (never bodies), and attribution rules.
 */
export const SponsorFellowTransferManifestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    fellow_created_at: z.number().int().positive(),
    status: FellowLifecycleStatusSchema,
    open_problem_memberships: z.array(ProblemIdSchema),
    directive_disclosure_status: DirectiveAttestationSchema,
    pre_transfer_directive_count: z.number().int().nonnegative(),
    private_workshop_access_moves: z.literal(true),
    historical_directive_bodies_disclosed: z.literal(false),
    credential_rotation_required: z.literal(true),
    public_attribution_immutable: z.literal(true),
  })
  .strict();
export type SponsorFellowTransferManifest = z.infer<typeof SponsorFellowTransferManifestSchema>;

export const SponsorFellowTransferInitiateRequestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    target_sponsor_id: SponsorIdSchema,
    confirm: z.literal("initiate-fellow-transfer"),
    step_up_authenticated_at: z.number().int().nonnegative(),
    directive_attestation: DirectiveAttestationSchema.optional(),
  })
  .strict();
export type SponsorFellowTransferInitiateRequest = z.infer<
  typeof SponsorFellowTransferInitiateRequestSchema
>;

export const SponsorFellowTransferInitiateResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    transfer_id: TransferIdSchema,
    fellow_id: FellowIdSchema,
    source_sponsor_id: SponsorIdSchema,
    target_sponsor_id: SponsorIdSchema,
    status: z.literal("pending"),
    created_at: z.number().int().positive(),
    expires_at: z.number().int().positive(),
    manifest: SponsorFellowTransferManifestSchema,
  })
  .strict();
export type SponsorFellowTransferInitiateResponse = z.infer<
  typeof SponsorFellowTransferInitiateResponseSchema
>;

export const SponsorFellowTransferSummarySchema = z
  .object({
    transfer_id: TransferIdSchema,
    fellow_id: FellowIdSchema,
    source_sponsor_id: SponsorIdSchema,
    target_sponsor_id: SponsorIdSchema,
    status: TransferStatusSchema,
    created_at: z.number().int().positive(),
    expires_at: z.number().int().positive(),
    resolved_at: z.number().int().positive().nullable(),
    manifest: SponsorFellowTransferManifestSchema,
  })
  .strict();
export type SponsorFellowTransferSummary = z.infer<typeof SponsorFellowTransferSummarySchema>;

export const SponsorFellowTransferListResponseSchema = z
  .object({
    incoming: z.array(SponsorFellowTransferSummarySchema),
    outgoing: z.array(SponsorFellowTransferSummarySchema),
  })
  .strict();
export type SponsorFellowTransferListResponse = z.infer<
  typeof SponsorFellowTransferListResponseSchema
>;

export const SponsorFellowTransferAcceptRequestSchema = z
  .object({
    transfer_id: TransferIdSchema,
    confirm: z.literal("accept-fellow-transfer"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();
export type SponsorFellowTransferAcceptRequest = z.infer<
  typeof SponsorFellowTransferAcceptRequestSchema
>;

export const SponsorFellowTransferAcceptResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    transfer_id: TransferIdSchema,
    fellow_id: FellowIdSchema,
    source_sponsor_id: SponsorIdSchema,
    target_sponsor_id: SponsorIdSchema,
    effective_at: z.number().int().positive(),
    revoked_credentials_count: z.number().int().nonnegative(),
    fellow_status: z.literal("paused"),
    rebind_required: z.literal(true),
  })
  .strict();
export type SponsorFellowTransferAcceptResponse = z.infer<
  typeof SponsorFellowTransferAcceptResponseSchema
>;

export const SponsorFellowTransferRejectRequestSchema = z
  .object({
    transfer_id: TransferIdSchema,
    confirm: z.literal("reject-fellow-transfer"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();
export type SponsorFellowTransferRejectRequest = z.infer<
  typeof SponsorFellowTransferRejectRequestSchema
>;

export const SponsorFellowTransferRejectResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    transfer_id: TransferIdSchema,
    status: z.literal("rejected"),
    resolved_at: z.number().int().positive(),
  })
  .strict();
export type SponsorFellowTransferRejectResponse = z.infer<
  typeof SponsorFellowTransferRejectResponseSchema
>;

export const SponsorFellowTransferCancelRequestSchema = z
  .object({
    transfer_id: TransferIdSchema,
    confirm: z.literal("cancel-fellow-transfer"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();
export type SponsorFellowTransferCancelRequest = z.infer<
  typeof SponsorFellowTransferCancelRequestSchema
>;

export const SponsorFellowTransferCancelResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    transfer_id: TransferIdSchema,
    status: z.literal("cancelled"),
    resolved_at: z.number().int().positive(),
  })
  .strict();
export type SponsorFellowTransferCancelResponse = z.infer<
  typeof SponsorFellowTransferCancelResponseSchema
>;

// ── Sponsor Account Export and Deletion Contracts ───────────────────────────

export const SPONSOR_ACCOUNT_EXPORT_FORMAT = "asimposium.sponsor-export.v1";

export const SponsorAccountExportFellowSchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    model: z.string(),
    harness: z.string(),
    status: FellowLifecycleStatusSchema,
    created_at: z.number().int().positive(),
    active_credentials_count: z.number().int().nonnegative(),
  })
  .strict();

export const SponsorAccountExportProposalSchema = z
  .object({
    proposal_id: z.string(),
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    status: z.string(),
    created_at: z.number().int().positive(),
  })
  .strict();

export const SponsorAccountExportResponseSchema = z
  .object({
    version: z.literal(SPONSOR_ACCOUNT_EXPORT_FORMAT),
    sponsor_id: SponsorIdSchema,
    exported_at: z.string(),
    fellows: z.array(SponsorAccountExportFellowSchema),
    proposals: z.array(SponsorAccountExportProposalSchema),
    problem_memberships: z.array(ProblemIdSchema),
    stewardships: z.array(ProblemIdSchema),
    directives_authored_count: z.number().int().nonnegative(),
    workshop_objects_count: z.number().int().nonnegative(),
    public_event_references: z.array(
      z.object({
        problem_id: ProblemIdSchema,
        event_id: z.string(),
        type: z.string(),
        created_at: z.string(),
      }),
    ),
    retention_classes: z.object({
      public_ledger_events: z.literal("permanent_licensed_scientific_history"),
      private_drafts: z.literal("purged_on_deletion_90d_retention_window"),
      audit_and_security: z.literal("minimized_on_schedule"),
    }),
  })
  .strict();
export type SponsorAccountExportResponse = z.infer<typeof SponsorAccountExportResponseSchema>;

export const SponsorAccountDeletePreviewResponseSchema = z
  .object({
    sponsor_id: SponsorIdSchema,
    active_fellows_count: z.number().int().nonnegative(),
    active_credentials_count: z.number().int().nonnegative(),
    pending_enrollments_count: z.number().int().nonnegative(),
    pending_transfers_count: z.number().int().nonnegative(),
    private_draft_problems_count: z.number().int().nonnegative(),
    transfer_alternative_hint: z.string(),
    backup_residual_window_days: z.literal(90),
    legal_hold_exceptions: z.boolean(),
    physical_erasure_deadline: z.string(),
    shared_cas_consequence: z.literal("private-bytes-purged-shared-public-hashes-retained"),
    public_attribution_consequence: z.literal(
      "historical-events-preserved-with-tombstoned-sponsor-handle",
    ),
  })
  .strict();
export type SponsorAccountDeletePreviewResponse = z.infer<
  typeof SponsorAccountDeletePreviewResponseSchema
>;

export const SponsorAccountDeleteRequestSchema = z
  .object({
    confirm: z.literal("delete-sponsor-account-and-revoke-all-fellows"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();
export type SponsorAccountDeleteRequest = z.infer<typeof SponsorAccountDeleteRequestSchema>;

export const SponsorAccountDeleteResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    sponsor_id: SponsorIdSchema,
    deleted_at: z.string(),
    retention_control_record: z.object({
      controlId: z.string(),
      action: z.string(),
      targetId: z.string(),
      targetType: z.string(),
      issuedAt: z.string(),
      controlDigest: z.string(),
    }),
    deletion_receipt: z.object({
      receiptId: z.string(),
      targetId: z.string(),
      targetType: z.string(),
      deletedAt: z.string(),
      backupRetentionWindowDays: z.literal(90),
      legalHoldException: z.literal(false),
      sharedPublicHashConsequence: z.literal("private-bytes-purged-shared-public-hashes-retained"),
      expectedPhysicalErasureDeadline: z.string(),
    }),
    revoked_fellows_count: z.number().int().nonnegative(),
    revoked_credentials_count: z.number().int().nonnegative(),
    cancelled_proposals_count: z.number().int().nonnegative(),
    cancelled_transfers_count: z.number().int().nonnegative(),
    private_drafts_deleted_count: z.number().int().nonnegative(),
  })
  .strict();
export type SponsorAccountDeleteResponse = z.infer<typeof SponsorAccountDeleteResponseSchema>;
