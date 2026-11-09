import {
  ARTIFACT_MAX_RESUMPTIONS,
  ARTIFACT_UPLOADS_SCHEMA_ID,
  ArtifactIdempotencyKeySchema,
  type ArtifactResumeRequest,
  ArtifactResumeRequestSchema,
  ArtifactResumeResponseSchema,
} from "@asimposium/contracts/artifact-uploads";
import type { D1Database } from "@cloudflare/workers-types";
import { artifactSha256 } from "./artifact-inspection.ts";
import {
  type ArtifactActor,
  type ArtifactManifest,
  ArtifactUploadError,
  readArtifactManifest,
  translateArtifactFailure,
} from "./artifact-store.ts";

interface AuthorizationReceipt {
  upload_id: string;
  generation: number;
  fellow_id: string;
  sponsor_id: string;
  session_id: string;
  authorized_at: number;
  problem_id: string;
  expires_at: number;
}

const fail = (code: ArtifactUploadError["code"]): never => {
  throw new ArtifactUploadError(code);
};

function receipt(row: AuthorizationReceipt) {
  return ArtifactResumeResponseSchema.parse({
    schema: ARTIFACT_UPLOADS_SCHEMA_ID,
    upload_id: row.upload_id,
    problem_id: row.problem_id,
    session_id: row.session_id,
    generation: row.generation,
    resumed_at: row.authorized_at,
    expires_at: row.expires_at,
    status_path: `/v1/artifacts/${row.upload_id}`,
  });
}

/** Rebind only future upload work. The immutable declaration, reserved bytes,
 * part intents, original sealed grants and original deadline all survive.
 * Metadata-only accepted receipts are recoverable through a replacement token;
 * replay never changes the current authorization or discloses a PUT secret. */
export async function resumeArtifactUpload(
  db: D1Database,
  actor: ArtifactActor,
  uploadId: string,
  input: ArtifactResumeRequest,
  idempotencyKey: string,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
) {
  if (
    !ArtifactResumeRequestSchema.safeParse(input).success ||
    !ArtifactIdempotencyKeySchema.safeParse(idempotencyKey).success
  )
    return fail("MISMATCH");
  const keyHash = await artifactSha256(new TextEncoder().encode(idempotencyKey));
  async function replay() {
    const prior = await db
      .prepare(`SELECT r.*, u.problem_id, u.expires_at FROM artifact_upload_authorizations r
        JOIN artifact_uploads u ON u.upload_id = r.upload_id
        WHERE r.fellow_id = ? AND r.key_hash = ?`)
      .bind(actor.fellowId, keyHash)
      .first<AuthorizationReceipt>();
    if (!prior) return undefined;
    if (
      prior.upload_id !== uploadId ||
      prior.sponsor_id !== actor.sponsorId ||
      prior.session_id !== input.session_id ||
      prior.generation !== input.expected_generation + 1
    )
      return fail("CONFLICT");
    // A currently authorized owner may recover the receipt even after its
    // working session closes or a later resumption changes the generation.
    await readArtifactManifest(db, actor, uploadId, clock());
    return receipt(prior);
  }
  try {
    const row = await readArtifactManifest(db, actor, uploadId, clock());
    const prior = await replay();
    if (prior) return prior;
    if (row.state === "quarantined") return fail("CONTENT_REFUSED");
    if (row.state === "verified") return fail("CONFLICT");
    const now = clock();
    if (row.state === "expired" || now >= row.expires_at) return fail("EXPIRED");
    if (input.expected_generation !== row.authorization_generation) return fail("CONFLICT");
    if (row.authorization_generation >= ARTIFACT_MAX_RESUMPTIONS) return fail("RECOVERY_LIMIT");
    if (row.lease_until !== null && row.lease_until > now) return fail("BUSY");
    await authorizeNew?.(row);
    const authorizedAt = clock();
    await db
      .prepare(`INSERT INTO artifact_upload_authorizations
        (upload_id, generation, fellow_id, sponsor_id, credential_id, session_id, authorized_at, key_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        uploadId,
        input.expected_generation + 1,
        actor.fellowId,
        actor.sponsorId,
        actor.credentialId,
        input.session_id,
        authorizedAt,
        keyHash,
      )
      .run();
    return receipt({
      upload_id: uploadId,
      generation: input.expected_generation + 1,
      fellow_id: actor.fellowId,
      sponsor_id: actor.sponsorId,
      session_id: input.session_id,
      authorized_at: authorizedAt,
      problem_id: row.problem_id,
      expires_at: row.expires_at,
    });
  } catch (error) {
    // Atomic generation comparison admits one winner. A concurrent identical
    // key resolves to that winner, while changed requests remain conflicts.
    try {
      const winner = await replay();
      if (winner) return winner;
    } catch (replayError) {
      if (replayError instanceof ArtifactUploadError) throw replayError;
    }
    return translateArtifactFailure(error);
  }
}
