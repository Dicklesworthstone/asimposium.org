import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  ARTIFACT_REPLAY_MS,
  ARTIFACT_STAGING_RETRY_MS,
  ARTIFACT_VERIFY_LEASE_MS,
  clearArtifactStaging,
} from "./artifact-store.ts";

export const ARTIFACT_STAGING_SWEEP_LIMIT = 16;
export { ARTIFACT_STAGING_RETRY_MS };

/** Only the manifest's transient input namespace is eligible. This is not CAS
 * garbage collection: shared/public bytes, backups and quarantined uploads are
 * never selected. Existing terminal manifests and byte reservations survive.
 *
 * Wait past the complete 24-hour upload window and the verifier's lease, even
 * for a previously verified upload. A sealed PUT can remain valid after an
 * early completion. Explicit operator holds live on the durable queue and a
 * hold cannot be acknowledged while an existing cleanup lease is outstanding.
 *
 * Successful rows are checked again after the original replay interval. A PUT
 * that started before capability expiry may finish late; one successful delete
 * must not permanently certify that the staging key can never reappear. */
const ELIGIBLE_UPLOAD = `u.state IN ('presigned', 'verified', 'expired')
  AND u.expires_at <= ? - ${ARTIFACT_VERIFY_LEASE_MS}
  AND u.put_expires_at <= ? - ${ARTIFACT_VERIFY_LEASE_MS}
  AND NOT EXISTS (SELECT 1 FROM artifact_put_renewals r
    WHERE r.upload_id = u.upload_id AND r.put_expires_at > ? - ${ARTIFACT_VERIFY_LEASE_MS})
  AND (u.lease_until IS NULL OR u.lease_until <= ?)`;

export interface ArtifactStagingRetentionResult {
  readonly scanned: number;
  readonly expired: number;
  readonly cleared: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
}

function instant(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 1 || now > Number.MAX_SAFE_INTEGER - ARTIFACT_REPLAY_MS)
    throw new Error("ARTIFACT_STAGING_CLOCK_INVALID");
  return now;
}

/** Run from the real Worker cron. Selection and every storage operation are
 * bounded; no bucket enumeration or caller-provided object key is involved. */
export async function reconcileArtifactStaging(
  db: D1Database,
  bucket: R2Bucket,
  clock: () => number = Date.now,
  limit = ARTIFACT_STAGING_SWEEP_LIMIT,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<ArtifactStagingRetentionResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_STAGING_SWEEP_LIMIT)
    throw new Error("ARTIFACT_STAGING_LIMIT_INVALID");
  const selectedAt = instant(clock);
  const candidates = await db
    .prepare(`SELECT q.upload_id FROM artifact_staging_retention q
      JOIN artifact_uploads u ON u.upload_id = q.upload_id
      WHERE q.held = 0 AND q.deletion_pending = 0 AND q.next_attempt_at <= ?
        AND (q.lease_until IS NULL OR q.lease_until <= ?)
        AND ${ELIGIBLE_UPLOAD}
      ORDER BY q.next_attempt_at, q.upload_id LIMIT ?`)
    .bind(selectedAt, selectedAt, selectedAt, selectedAt, selectedAt, selectedAt, limit)
    .all<{ upload_id: string }>();
  if (!candidates.success) throw new Error("ARTIFACT_STAGING_SELECTION_FAILED");
  let expired = 0;
  let cleared = 0;
  let failed = 0;
  let skipped = 0;
  for (const candidate of candidates.results) {
    const uploadId = candidate.upload_id;
    const token = crypto.randomUUID().replaceAll("-", "");
    try {
      const now = instant(clock);
      const leased = await db
        .prepare(`UPDATE artifact_staging_retention SET lease_token = ?, lease_until = ?,
            attempts = attempts + 1
          WHERE upload_id = ? AND held = 0 AND deletion_pending = 0 AND next_attempt_at <= ?
            AND (lease_until IS NULL OR lease_until <= ?)
            AND EXISTS (SELECT 1 FROM artifact_uploads u
              WHERE u.upload_id = artifact_staging_retention.upload_id AND ${ELIGIBLE_UPLOAD})
          RETURNING upload_id`)
        .bind(token, now + ARTIFACT_VERIFY_LEASE_MS, uploadId, now, now, now, now, now, now)
        .first<{ upload_id: string }>();
      if (!leased) {
        skipped += 1;
        continue;
      }
      // The existing manifest trigger records exactly one expiry audit event.
      // A concurrent completer or active part writer makes this UPDATE lose.
      const transitioned = await db
        .prepare(`UPDATE artifact_uploads SET state = 'expired', updated_at = ?,
            lease_token = NULL, lease_until = NULL
          WHERE upload_id = ? AND state = 'presigned' AND expires_at <= ?
            AND (lease_until IS NULL OR lease_until <= ?)
            AND EXISTS (SELECT 1 FROM artifact_staging_retention q
              WHERE q.upload_id = artifact_uploads.upload_id AND q.held = 0
                AND q.lease_token = ? AND q.lease_until > ?)
          RETURNING upload_id`)
        .bind(now, uploadId, now, now, token, now)
        .first<{ upload_id: string }>();
      if (transitioned) expired += 1;
      const checkedAt = instant(clock);
      const current = await db
        .prepare(`SELECT q.upload_id FROM artifact_staging_retention q
          JOIN artifact_uploads u ON u.upload_id = q.upload_id
          WHERE q.upload_id = ? AND q.held = 0 AND q.lease_token = ? AND q.lease_until > ?
            AND u.state IN ('verified', 'expired') AND ${ELIGIBLE_UPLOAD}`)
        .bind(uploadId, token, checkedAt, checkedAt, checkedAt, checkedAt, checkedAt)
        .first<{ upload_id: string }>();
      if (!current) {
        skipped += 1;
        await db
          .prepare(`UPDATE artifact_staging_retention SET lease_token = NULL, lease_until = NULL,
              next_attempt_at = ? WHERE upload_id = ? AND lease_token = ?`)
          .bind(checkedAt + ARTIFACT_STAGING_RETRY_MS, uploadId, token)
          .run();
        continue;
      }
      if (
        await clearArtifactStaging({
          db,
          bucket,
          uploadId,
          token,
          clock,
          scheduled: true,
          waitUntil,
        })
      )
        cleared += 1;
      else skipped += 1;
    } catch {
      failed += 1;
      // No secret URL, private key, filename, content or provider exception is
      // emitted. A later tick safely retries the same immutable staging keys.
      // An unresolved provider request keeps deletion_pending and its lease.
      // Only its real acknowledgment may clear that state, never a later tick.
      try {
        await db
          .prepare(`UPDATE artifact_staging_retention SET next_attempt_at = ?,
              lease_token = NULL, lease_until = NULL
            WHERE upload_id = ? AND lease_token = ? AND deletion_pending = 0`)
          .bind(instant(clock) + ARTIFACT_STAGING_RETRY_MS, uploadId, token)
          .run();
      } catch {
        // A failed D1 acknowledgment must remain visibly pending.
      }
    }
  }
  const unresolved = await db
    .prepare("SELECT COUNT(*) AS n FROM artifact_staging_retention WHERE deletion_pending = 1")
    .first<{ n: number }>();
  if (!unresolved || !Number.isSafeInteger(unresolved.n) || unresolved.n < 0)
    throw new Error("ARTIFACT_STAGING_PENDING_READ_FAILED");
  return {
    scanned: candidates.results.length,
    expired,
    cleared,
    failed,
    skipped,
    pending: unresolved.n,
  };
}
