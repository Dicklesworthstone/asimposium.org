import type { SponsorAccountDeletePreviewResponse } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";

/** Private identity-only snapshot. No token, enrollment secret, or private body is selected. */
export const AccountDeletionSnapshotSchema = z
  .object({
    sponsor_id: z.string().min(1),
    revision: z.number().int().nonnegative().safe(),
    fellows: z.array(z.object({ id: z.string().min(1), status: z.string().min(1) }).strict()),
    credentials: z.array(
      z
        .object({
          id: z.string().min(1),
          issued_at: z.number().int(),
          expires_at: z.number().int().nullable(),
        })
        .strict(),
    ),
    enrollments: z.array(z.string().min(1)),
    proposals: z.array(z.string().min(1)),
    transfers: z.array(z.string().min(1)),
    rebinds: z.array(z.object({ id: z.string().min(1), status: z.string().min(1) }).strict()),
    private_drafts: z.array(z.string().min(1)),
  })
  .strict();
export type AccountDeletionSnapshot = z.infer<typeof AccountDeletionSnapshotSchema>;

// One statement reads one database snapshot. The export revision covers private
// content/ownership changes, while explicit credential and rebind identities cover
// authority metadata deliberately excluded from account exports. Expired but still
// unrevoked credentials and pending flows remain in the impact that will commit.
const SNAPSHOT_SQL = `
  WITH owner AS (
    SELECT s.sponsor_id, r.revision FROM sponsors s
    JOIN sponsor_export_revisions r ON r.sponsor_id = s.sponsor_id
    WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL
  )
  SELECT json_object(
    'sponsor_id', owner.sponsor_id,
    'revision', owner.revision,
    'fellows', json((SELECT json_group_array(json_object('id', fellow_id, 'status', status))
      FROM (SELECT fellow_id, status FROM enrollment_fellows
        WHERE sponsor_id = owner.sponsor_id AND status <> 'revoked' ORDER BY fellow_id))),
    'credentials', json((SELECT json_group_array(json_object(
        'id', credential_id, 'issued_at', issued_at, 'expires_at', expires_at))
      FROM (SELECT credential_id, issued_at, expires_at FROM fellow_tokens
        WHERE sponsor_id = owner.sponsor_id AND revoked_at IS NULL ORDER BY credential_id))),
    'enrollments', json((SELECT json_group_array(enrollment_id)
      FROM (SELECT enrollment_id FROM enrollment_records
        WHERE sponsor_id = owner.sponsor_id AND invalidated = 0 ORDER BY enrollment_id))),
    'proposals', json((SELECT json_group_array(proposal_id)
      FROM (SELECT p.proposal_id FROM enrollment_proposals p
        JOIN enrollment_records e ON e.enrollment_id = p.enrollment_id
        WHERE e.sponsor_id = owner.sponsor_id AND p.status = 'pending' ORDER BY p.proposal_id))),
    'transfers', json((SELECT json_group_array(transfer_id)
      FROM (SELECT transfer_id FROM sponsor_fellow_transfers
        WHERE (source_sponsor_id = owner.sponsor_id OR target_sponsor_id = owner.sponsor_id)
          AND status = 'pending' ORDER BY transfer_id))),
    'rebinds', json((SELECT json_group_array(json_object('id', rebind_id, 'status', status))
      FROM (SELECT rebind_id, status FROM fellow_rebinds WHERE sponsor_id = owner.sponsor_id
        AND status IN ('awaiting-claim', 'awaiting-approval', 'approved') ORDER BY rebind_id))),
    'private_drafts', json((SELECT json_group_array(id)
      FROM (SELECT p.id FROM problems p WHERE p.sponsor_id = owner.sponsor_id
        AND p.status = 'private-draft' AND p.public_seq = 0
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id) ORDER BY p.id)))
  ) AS snapshot_json FROM owner
`;

export async function readAccountDeletionSnapshot(
  db: D1Database,
  sponsorId: string,
): Promise<{ readonly snapshot: AccountDeletionSnapshot; readonly serialized: string } | null> {
  const row = await db.prepare(SNAPSHOT_SQL).bind(sponsorId).first<{ snapshot_json: string }>();
  if (row === null) return null;
  const snapshot = AccountDeletionSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  if (snapshot.sponsor_id !== sponsorId) throw new Error("Account deletion snapshot mismatch");
  return { snapshot, serialized: row.snapshot_json };
}

/** This must be the first statement in the deletion transaction. */
export function accountDeletionSnapshotGuard(
  db: D1Database,
  sponsorId: string,
  serialized: string,
): D1PreparedStatement {
  return db
    .prepare(`SELECT CASE WHEN (${SNAPSHOT_SQL}) = ? THEN 1
    ELSE json_extract('[]', '$[SPONSOR_DELETE_PREVIEW_CHANGED') END`)
    .bind(sponsorId, serialized);
}

export function isAccountDeletionSnapshotChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SPONSOR_DELETE_PREVIEW_CHANGED") ||
      (error.cause !== undefined && isAccountDeletionSnapshotChanged(error.cause)))
  );
}

export async function accountDeletionReview(
  snapshot: AccountDeletionSnapshot,
): Promise<SponsorAccountDeletePreviewResponse["review"]> {
  const version = "asimposium.sponsor-deletion.v1" as const;
  const encoded = new TextEncoder().encode(JSON.stringify({ version, snapshot }));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { version, digest: `sha256:${hex}` };
}

export async function accountDeletionPreview(
  snapshot: AccountDeletionSnapshot,
  now: number,
): Promise<SponsorAccountDeletePreviewResponse> {
  return {
    sponsor_id: snapshot.sponsor_id,
    review: await accountDeletionReview(snapshot),
    active_fellows_count: snapshot.fellows.filter((fellow) => fellow.status === "active").length,
    active_credentials_count: snapshot.credentials.filter(
      (credential) =>
        credential.issued_at <= now &&
        (credential.expires_at === null || credential.expires_at > now),
    ).length,
    fellows_to_revoke_count: snapshot.fellows.length,
    credentials_to_revoke_count: snapshot.credentials.length,
    enrollment_links_to_invalidate_count: snapshot.enrollments.length,
    pending_enrollments_count: snapshot.proposals.length,
    pending_transfers_count: snapshot.transfers.length,
    pending_rebinds_count: snapshot.rebinds.length,
    private_draft_problems_count: snapshot.private_drafts.length,
    transfer_alternative_hint:
      "You can bilaterally transfer your Fellows to another living sponsor before account deletion using POST /v1/sponsors/transfers.",
    backup_residual_window_days: 90,
    legal_hold_exceptions: false,
    physical_erasure_deadline: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(),
    shared_cas_consequence: "private-bytes-purged-shared-public-hashes-retained",
    public_attribution_consequence: "historical-events-preserved-with-tombstoned-sponsor-handle",
  };
}
