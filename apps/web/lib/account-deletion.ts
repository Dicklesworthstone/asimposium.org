import "server-only";

import {
  type SponsorAccountDeletePreviewResponse,
  SponsorAccountDeletePreviewResponseSchema,
  type SponsorAccountDeleteRequest,
  SponsorAccountDeleteRequestSchema,
  type SponsorAccountDeleteResponse,
  SponsorAccountDeleteResponseSchema,
} from "@asimposium/contracts";
import { callStoa, type StoaCall } from "./stoa";
import { isAccountDeletionRetryKey } from "./account-deletion-recovery";

export function stoaAccountDeletionPreview(
  principalId: string,
): Promise<StoaCall<SponsorAccountDeletePreviewResponse>> {
  return callStoa({
    method: "GET", route: "/v1/sponsors/account/delete-preview",
    path: "/v1/sponsors/account/delete-preview", action: "sponsor.account.delete-preview",
    principalId, body: "", responseMaxBytes: 32_768,
    parse: (value) => {
      const preview = SponsorAccountDeletePreviewResponseSchema.parse(value);
      if (preview.sponsor_id !== principalId) throw new Error("Deletion preview owner mismatch");
      return preview;
    },
  });
}

export function stoaDeleteAccount(
  principalId: string,
  request: SponsorAccountDeleteRequest,
  idempotencyKey: string,
): Promise<StoaCall<SponsorAccountDeleteResponse>> {
  const command = SponsorAccountDeleteRequestSchema.safeParse(request);
  if (!command.success || !isAccountDeletionRetryKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  }
  return callStoa({
    method: "POST", route: "/v1/sponsors/account/delete", path: "/v1/sponsors/account/delete",
    action: "sponsor.account.delete", principalId,
    body: JSON.stringify(command.data), idempotencyKey, responseMaxBytes: 32_768,
    parse: (value) => {
      const receipt = SponsorAccountDeleteResponseSchema.parse(value);
      if (
        receipt.sponsor_id !== principalId || receipt.review.digest !== command.data.expected_preview.digest ||
        receipt.review.version !== command.data.expected_preview.version ||
        receipt.retention_control_record.targetId !== principalId ||
        receipt.retention_control_record.action !== "delete-account-private-data" ||
        receipt.retention_control_record.targetType !== "user_private_data" ||
        receipt.deletion_receipt.targetId !== principalId || receipt.deletion_receipt.targetType !== "sponsor" ||
        receipt.deletion_receipt.deletedAt !== receipt.deleted_at ||
        receipt.retention_control_record.issuedAt !== receipt.deleted_at
      ) throw new Error("Deletion receipt does not match the confirmed account and impact");
      return receipt;
    },
  });
}
