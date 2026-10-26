import {
  SponsorAccountDeletePreviewResponseSchema,
  SponsorAccountDeleteResponseSchema,
  type SponsorAccountDeleteRequest,
} from "@asimposium/contracts";

export const deletionSponsor = "usr_account_deletion_fixture";
export const deletionPreview = SponsorAccountDeletePreviewResponseSchema.parse({
  sponsor_id: deletionSponsor,
  review: { version: "asimposium.sponsor-deletion.v1", digest: `sha256:${"a".repeat(64)}` },
  active_fellows_count: 1, active_credentials_count: 1,
  fellows_to_revoke_count: 2, credentials_to_revoke_count: 3,
  enrollment_links_to_invalidate_count: 4, pending_enrollments_count: 1,
  pending_transfers_count: 2, pending_rebinds_count: 1, private_draft_problems_count: 2,
  transfer_alternative_hint: "Complete a bilateral Fellow transfer before deleting this account.",
  backup_residual_window_days: 90, legal_hold_exceptions: false,
  physical_erasure_deadline: "2027-01-24T12:00:00.000Z",
  shared_cas_consequence: "artifact-bytes-follow-retention-policy-shared-public-hashes-retained",
  private_draft_consequence: "erased-with-audit-and-quota-evidence-retained",
  public_attribution_consequence: "historical-events-preserved-with-tombstoned-sponsor-handle",
});
export const deletionCommand: SponsorAccountDeleteRequest = {
  confirm: "delete-sponsor-account-and-revoke-all-fellows", expected_preview: deletionPreview.review,
  step_up_authenticated_at: 1_793_016_000,
};
export const deletionReceipt = SponsorAccountDeleteResponseSchema.parse({
  acknowledged: true, sponsor_id: deletionSponsor, review: deletionPreview.review,
  deleted_at: "2026-10-26T12:00:00.000Z",
  retention_control_record: { controlId: "RC-deletion-fixture", action: "delete-account-private-data",
    targetId: deletionSponsor, targetType: "user_private_data", issuedAt: "2026-10-26T12:00:00.000Z",
    controlDigest: "b".repeat(64) },
  deletion_receipt: { receiptId: "DEL-deletion-fixture", targetId: deletionSponsor, targetType: "sponsor",
    deletedAt: "2026-10-26T12:00:00.000Z", backupRetentionWindowDays: 90, legalHoldException: false,
    sharedPublicHashConsequence: "artifact-bytes-follow-retention-policy-shared-public-hashes-retained",
    privateDraftContent: "erased-with-audit-and-quota-evidence-retained",
    expectedPhysicalErasureDeadline: "2027-01-24T12:00:00.000Z" },
  revoked_fellows_count: 2, revoked_credentials_count: 3, invalidated_enrollments_count: 4,
  cancelled_proposals_count: 1, cancelled_transfers_count: 2, superseded_rebinds_count: 1,
  private_drafts_deleted_count: 2,
});
