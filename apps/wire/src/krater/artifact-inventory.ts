import {
  ARTIFACT_INVENTORY_DEFAULT_LIMIT,
  ARTIFACT_UPLOADS_SCHEMA_ID,
  type ArtifactInventoryQuery,
  ArtifactInventoryResponseSchema,
} from "@asimposium/contracts/artifact-uploads";
import type { D1Database } from "@cloudflare/workers-types";
import {
  ARTIFACT_READ_AUTHORITY_SQL,
  type ArtifactActor,
  type ArtifactManifest,
  ArtifactUploadError,
} from "./artifact-store.ts";

/** One bounded indexed query, no storage reads and no per-item authorization
 * round trips. Immutable upload IDs keep edits from moving pagination entries.
 * Refresh the first page to discover new IDs or changed upload states. */
export async function listArtifactUploads(
  db: D1Database,
  actor: ArtifactActor,
  query: ArtifactInventoryQuery,
  now = Date.now(),
) {
  const limit = Number(query.limit ?? ARTIFACT_INVENTORY_DEFAULT_LIMIT);
  const rows = await db
    .prepare(`SELECT a.upload_id, a.problem_id, a.session_id, a.sha256,
      a.size_bytes, a.encoding, a.state, a.created_at, a.expires_at
      ${ARTIFACT_READ_AUTHORITY_SQL}
      AND a.fellow_id = ? AND a.sponsor_id = ? AND a.upload_id > ?
      ORDER BY a.upload_id LIMIT ?`)
    .bind(
      actor.credentialId,
      now,
      now,
      now,
      actor.fellowId,
      actor.sponsorId,
      query.after ?? "",
      limit + 1,
    )
    .all<ArtifactManifest>();
  if (!rows.success) throw new ArtifactUploadError("UNAVAILABLE");
  const items = rows.results.slice(0, limit).map((row) => ({
    upload_id: row.upload_id,
    problem_id: row.problem_id,
    original_session_id: row.session_id,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    encoding: row.encoding,
    state: row.state === "presigned" && now >= row.expires_at ? "expired" : row.state,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status_path: `/v1/artifacts/${row.upload_id}`,
  }));
  const nextAfter = rows.results.length > limit ? items.at(-1)!.upload_id : null;
  return ArtifactInventoryResponseSchema.parse({
    schema: ARTIFACT_UPLOADS_SCHEMA_ID,
    after: query.after ?? null,
    next_after: nextAfter,
    next_path: nextAfter === null ? null : `/v1/artifacts?after=${nextAfter}&limit=${limit}`,
    items,
    omitted: nextAfter === null ? [] : ["page_limit"],
  });
}
