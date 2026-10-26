import { SponsorAccountDeletePreviewResponseSchema, type SponsorAccountDeletePreviewResponse } from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

/** Only reviewed counts, policy consequences and a retry key; no account export or credential material. */
export interface PendingAccountDeletion {
  readonly version: "asimposium.account-deletion-recovery.v1";
  readonly sponsor_id: string;
  readonly preview: SponsorAccountDeletePreviewResponse;
  readonly idempotency_key: string;
}

export function isAccountDeletionRetryKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160 && !/[^A-Za-z0-9._-]/u.test(value);
}

export function accountDeletionRecoveryKey(sponsorId: string): string {
  if (!isCanonicalSponsorId(sponsorId)) throw new Error("Invalid deletion recovery owner");
  return `asimposium.account-deletion.v1:${sponsorId}`;
}

export function parsePendingAccountDeletion(raw: string, sponsorId: string): PendingAccountDeletion {
  if (raw.length > 16_384 || !isCanonicalSponsorId(sponsorId)) throw new Error("Invalid deletion recovery");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deletion recovery");
  const record = value as Record<string, unknown>;
  const preview = SponsorAccountDeletePreviewResponseSchema.safeParse(record.preview);
  if (
    Object.keys(record).sort().join(",") !== "idempotency_key,preview,sponsor_id,version" ||
    record.version !== "asimposium.account-deletion-recovery.v1" || record.sponsor_id !== sponsorId ||
    !isAccountDeletionRetryKey(record.idempotency_key) ||
    !preview.success || preview.data.sponsor_id !== sponsorId
  ) throw new Error("Invalid deletion recovery");
  return { version: "asimposium.account-deletion-recovery.v1", sponsor_id: sponsorId,
    preview: preview.data, idempotency_key: record.idempotency_key };
}

/** Persist and read back before sending; never replace an unresolved confirmation. */
export function persistPendingAccountDeletion(
  storage: Pick<Storage, "getItem" | "setItem">,
  pending: PendingAccountDeletion,
): void {
  const key = accountDeletionRecoveryKey(pending.sponsor_id);
  const serialized = JSON.stringify(parsePendingAccountDeletion(JSON.stringify(pending), pending.sponsor_id));
  const existing = storage.getItem(key);
  if (existing !== null && JSON.stringify(parsePendingAccountDeletion(existing, pending.sponsor_id)) !== serialized) {
    throw new Error("An unresolved account deletion already exists");
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("Deletion recovery could not be saved");
}

export function clearPendingAccountDeletion(
  storage: Pick<Storage, "getItem" | "removeItem">,
  pending: PendingAccountDeletion,
): void {
  const key = accountDeletionRecoveryKey(pending.sponsor_id);
  const existing = storage.getItem(key);
  if (existing === null) return;
  const stored = parsePendingAccountDeletion(existing, pending.sponsor_id);
  if (stored.idempotency_key !== pending.idempotency_key || stored.preview.review.digest !== pending.preview.review.digest) {
    throw new Error("A different confirmation is still pending");
  }
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Deletion recovery could not be cleared");
}
