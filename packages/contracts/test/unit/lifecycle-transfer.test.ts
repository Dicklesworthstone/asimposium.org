import { describe, expect, test } from "bun:test";
import {
  DirectiveAttestationSchema,
  SponsorAccountDeletePreviewResponseSchema,
  SponsorAccountDeleteRequestSchema,
  SponsorAccountDeleteResponseSchema,
  SponsorAccountExportResponseSchema,
  SponsorFellowTransferAcceptRequestSchema,
  SponsorFellowTransferAcceptResponseSchema,
  SponsorFellowTransferCancelRequestSchema,
  SponsorFellowTransferCancelResponseSchema,
  SponsorFellowTransferInitiateRequestSchema,
  SponsorFellowTransferInitiateResponseSchema,
  SponsorFellowTransferListResponseSchema,
  SponsorFellowTransferManifestSchema,
  SponsorFellowTransferRejectRequestSchema,
  SponsorFellowTransferRejectResponseSchema,
  TransferIdSchema,
  TransferStatusSchema,
} from "../../src/lifecycle-transfer.ts";

describe("W3.8 Transfer & Lifecycle Contracts", () => {
  const validTransferId = "TRF-01JXYZ4K6QA0123456789ABCDE";
  const validFellowId = "fellow-01JXYZ9876543210ABCDEF";
  const sourceSponsorId = "usr_sponsor_alpha";
  const targetSponsorId = "usr_sponsor_beta";

  const validManifest = {
    fellow_id: validFellowId,
    name: "valid-fellow-alpha",
    model: "claude-3-5-sonnet",
    harness: "claude-code",
    fellow_created_at: 1786000000,
    status: "active" as const,
    open_problem_memberships: ["P-4DSP"],
    directive_disclosure_status: "no_directives" as const,
    pre_transfer_directive_count: 0,
    private_workshop_access_moves: true as const,
    historical_directive_bodies_disclosed: false as const,
    credential_rotation_required: true as const,
    public_attribution_immutable: true as const,
  };

  test("validates TransferIdSchema correctly", () => {
    expect(TransferIdSchema.safeParse(validTransferId).success).toBe(true);
    expect(TransferIdSchema.safeParse("TRF-bad-length").success).toBe(false);
    expect(TransferIdSchema.safeParse("wrong_prefix").success).toBe(false);
    expect(TransferIdSchema.safeParse("").success).toBe(false);
  });

  test("validates TransferStatusSchema and DirectiveAttestationSchema", () => {
    expect(TransferStatusSchema.safeParse("pending").success).toBe(true);
    expect(TransferStatusSchema.safeParse("accepted").success).toBe(true);
    expect(TransferStatusSchema.safeParse("rejected").success).toBe(true);
    expect(TransferStatusSchema.safeParse("cancelled").success).toBe(true);
    expect(TransferStatusSchema.safeParse("expired").success).toBe(true);
    expect(TransferStatusSchema.safeParse("unknown").success).toBe(false);

    expect(DirectiveAttestationSchema.safeParse("no_directives").success).toBe(true);
    expect(DirectiveAttestationSchema.safeParse("attested_no_material_influence").success).toBe(
      true,
    );
    expect(DirectiveAttestationSchema.safeParse("disclosed").success).toBe(true);
    expect(DirectiveAttestationSchema.safeParse("unresolved").success).toBe(true);
    expect(DirectiveAttestationSchema.safeParse("other").success).toBe(false);
  });

  test("validates SponsorFellowTransferManifestSchema", () => {
    expect(SponsorFellowTransferManifestSchema.safeParse(validManifest).success).toBe(true);

    const tampered = { ...validManifest, private_workshop_access_moves: false };
    expect(SponsorFellowTransferManifestSchema.safeParse(tampered).success).toBe(false);

    const directiveBodyLeaked = { ...validManifest, historical_directive_bodies_disclosed: true };
    expect(SponsorFellowTransferManifestSchema.safeParse(directiveBodyLeaked).success).toBe(false);
  });

  test("validates SponsorFellowTransferInitiateRequest and Response", () => {
    const validReq = {
      fellow_id: validFellowId,
      target_sponsor_id: targetSponsorId,
      confirm: "initiate-fellow-transfer" as const,
      step_up_authenticated_at: 1786000100,
      directive_attestation: "no_directives" as const,
    };
    expect(SponsorFellowTransferInitiateRequestSchema.safeParse(validReq).success).toBe(true);

    const invalidConfirm = { ...validReq, confirm: "wrong-confirm" };
    expect(SponsorFellowTransferInitiateRequestSchema.safeParse(invalidConfirm).success).toBe(
      false,
    );

    const validResp = {
      acknowledged: true as const,
      transfer_id: validTransferId,
      fellow_id: validFellowId,
      source_sponsor_id: sourceSponsorId,
      target_sponsor_id: targetSponsorId,
      status: "pending" as const,
      created_at: 1786000100,
      expires_at: 1786086500,
      manifest: validManifest,
    };
    expect(SponsorFellowTransferInitiateResponseSchema.safeParse(validResp).success).toBe(true);
  });

  test("validates SponsorFellowTransferAcceptRequest and Response", () => {
    const validReq = {
      transfer_id: validTransferId,
      confirm: "accept-fellow-transfer" as const,
      step_up_authenticated_at: 1786000200,
    };
    expect(SponsorFellowTransferAcceptRequestSchema.safeParse(validReq).success).toBe(true);

    const validResp = {
      acknowledged: true as const,
      transfer_id: validTransferId,
      fellow_id: validFellowId,
      source_sponsor_id: sourceSponsorId,
      target_sponsor_id: targetSponsorId,
      effective_at: 1786000200,
      revoked_credentials_count: 2,
      fellow_status: "paused" as const,
      rebind_required: true as const,
    };
    expect(SponsorFellowTransferAcceptResponseSchema.safeParse(validResp).success).toBe(true);
  });

  test("validates SponsorFellowTransferReject and Cancel flows", () => {
    const rejectReq = {
      transfer_id: validTransferId,
      confirm: "reject-fellow-transfer" as const,
      step_up_authenticated_at: 1786000300,
    };
    expect(SponsorFellowTransferRejectRequestSchema.safeParse(rejectReq).success).toBe(true);

    const rejectResp = {
      acknowledged: true as const,
      transfer_id: validTransferId,
      status: "rejected" as const,
      resolved_at: 1786000300,
    };
    expect(SponsorFellowTransferRejectResponseSchema.safeParse(rejectResp).success).toBe(true);

    const cancelReq = {
      transfer_id: validTransferId,
      confirm: "cancel-fellow-transfer" as const,
      step_up_authenticated_at: 1786000400,
    };
    expect(SponsorFellowTransferCancelRequestSchema.safeParse(cancelReq).success).toBe(true);

    const cancelResp = {
      acknowledged: true as const,
      transfer_id: validTransferId,
      status: "cancelled" as const,
      resolved_at: 1786000400,
    };
    expect(SponsorFellowTransferCancelResponseSchema.safeParse(cancelResp).success).toBe(true);
  });

  test("validates SponsorFellowTransferListResponse", () => {
    const listResp = {
      incoming: [
        {
          transfer_id: validTransferId,
          fellow_id: validFellowId,
          source_sponsor_id: sourceSponsorId,
          target_sponsor_id: targetSponsorId,
          status: "pending" as const,
          created_at: 1786000100,
          expires_at: 1786086500,
          resolved_at: null,
          manifest: validManifest,
        },
      ],
      outgoing: [],
    };
    expect(SponsorFellowTransferListResponseSchema.safeParse(listResp).success).toBe(true);
  });

  test("validates SponsorAccountExportResponse without live secrets", () => {
    const exportResp = {
      version: "asimposium.sponsor-export.v1" as const,
      sponsor_id: sourceSponsorId,
      exported_at: "2026-09-22T03:00:00.000Z",
      fellows: [
        {
          fellow_id: validFellowId,
          name: "valid-fellow-alpha",
          model: "claude-3-5-sonnet",
          harness: "claude-code",
          status: "active" as const,
          created_at: 1786000000,
          active_credentials_count: 1,
        },
      ],
      proposals: [
        {
          proposal_id: "prop_01JXYZ",
          fellow_id: validFellowId,
          name: "valid-fellow-alpha",
          status: "approved",
          created_at: 1786000000,
        },
      ],
      problem_memberships: ["P-4DSP"],
      stewardships: [],
      directives_authored_count: 3,
      workshop_objects_count: 5,
      public_event_references: [
        {
          problem_id: "P-4DSP",
          event_id: "EVT-01JXYZ",
          type: "claim.created",
          created_at: "2026-09-22T03:10:00.000Z",
        },
      ],
      retention_classes: {
        public_ledger_events: "permanent_licensed_scientific_history" as const,
        private_drafts: "purged_on_deletion_90d_retention_window" as const,
        audit_and_security: "minimized_on_schedule" as const,
      },
    };
    expect(SponsorAccountExportResponseSchema.safeParse(exportResp).success).toBe(true);
  });

  test("validates SponsorAccountDeletePreview and Delete flow", () => {
    const previewResp = {
      sponsor_id: sourceSponsorId,
      active_fellows_count: 1,
      active_credentials_count: 1,
      pending_enrollments_count: 0,
      pending_transfers_count: 0,
      private_draft_problems_count: 1,
      transfer_alternative_hint:
        "Consider transferring active Fellows to another accountable sponsor before deletion.",
      backup_residual_window_days: 90 as const,
      legal_hold_exceptions: false,
      physical_erasure_deadline: "2026-12-21T03:00:00.000Z",
      shared_cas_consequence: "private-bytes-purged-shared-public-hashes-retained" as const,
      public_attribution_consequence:
        "historical-events-preserved-with-tombstoned-sponsor-handle" as const,
    };
    expect(SponsorAccountDeletePreviewResponseSchema.safeParse(previewResp).success).toBe(true);

    const deleteReq = {
      confirm: "delete-sponsor-account-and-revoke-all-fellows" as const,
      step_up_authenticated_at: 1786000500,
    };
    expect(SponsorAccountDeleteRequestSchema.safeParse(deleteReq).success).toBe(true);

    const deleteResp = {
      acknowledged: true as const,
      sponsor_id: sourceSponsorId,
      deleted_at: "2026-09-22T03:15:00.000Z",
      retention_control_record: {
        controlId: "RC-01JXYZRETENTION0000000001",
        action: "delete-account-private-data",
        targetId: sourceSponsorId,
        targetType: "user_private_data",
        issuedAt: "2026-09-22T03:15:00.000Z",
        controlDigest: "a".repeat(64),
      },
      deletion_receipt: {
        receiptId: "DR-01JXYZRECEIPT00000000001",
        targetId: sourceSponsorId,
        targetType: "user_private_data",
        deletedAt: "2026-09-22T03:15:00.000Z",
        backupRetentionWindowDays: 90 as const,
        legalHoldException: false as const,
        sharedPublicHashConsequence: "private-bytes-purged-shared-public-hashes-retained" as const,
        expectedPhysicalErasureDeadline: "2026-12-21T03:15:00.000Z",
      },
      revoked_fellows_count: 1,
      revoked_credentials_count: 1,
      cancelled_proposals_count: 0,
      cancelled_transfers_count: 0,
      private_drafts_deleted_count: 1,
    };
    expect(SponsorAccountDeleteResponseSchema.safeParse(deleteResp).success).toBe(true);
  });
});
