import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  artifactSha256, ArtifactInspectionError, inspectArtifact, type ArtifactEncoding,
} from "./artifact-inspection.ts";
import {
  artifactStagingKey, presignArtifactPut, type ArtifactSigningConfig, type ArtifactPutGrant,
} from "./artifact-presign.ts";

export type ArtifactFailure = "NOT_FOUND" | "NOT_ALLOWED" | "CONFLICT" | "EXPIRED" | "BUDGET" | "BUSY" | "NOT_UPLOADED" | "MISMATCH" | "CONTENT_REFUSED" | "UNAVAILABLE";
export class ArtifactUploadError extends Error {
  constructor(readonly code: ArtifactFailure) { super(code); this.name = "ArtifactUploadError"; }
}
export interface ArtifactActor { fellowId: string; credentialId: string; sponsorId: string }
export interface ArtifactDeclaration { sessionId: string; sha256: string; size: number; encoding: ArtifactEncoding }
export interface ArtifactReplayCodec {
  seal(value: string, context: string): Promise<{ ciphertext: string; initializationVector: string }>;
  open(value: { ciphertext: string; initializationVector: string }, context: string): Promise<string>;
}
export interface ArtifactManifest {
  upload_id: string;
  fellow_id: string;
  credential_id: string;
  sponsor_id: string;
  session_id: string;
  problem_id: string;
  sha256: string;
  size_bytes: number;
  encoding: ArtifactEncoding;
  state: "presigned" | "verified" | "quarantined" | "expired";
  created_at: number;
  updated_at: number;
  expires_at: number;
  put_expires_at: number;
  key_hash: string;
  request_digest: string;
  replay_ciphertext: string;
  replay_iv: string;
  content_type: string | null;
  inspected_members: number | null;
  expanded_bytes: number | null;
  verified_at: number | null;
}
export interface ArtifactCreated {
  upload_id: string;
  sha256: string;
  size_bytes: number;
  encoding: ArtifactEncoding;
  created_at: number;
  expires_at: number;
  storage: "private";
  put: ArtifactPutGrant;
}
export const ARTIFACT_REPLAY_MS = 24 * 60 * 60 * 1000;
export const ARTIFACT_VERIFY_LEASE_MS = 60_000;
export const ARTIFACT_STORAGE_TIMEOUT_MS = 15_000;
const encode = (value: string) => new TextEncoder().encode(value);
const id = () => `AU-${crypto.randomUUID().replaceAll("-", "")}`;
const fail = (code: ArtifactFailure): never => { throw new ArtifactUploadError(code); };
const casKey = (digest: string) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) return fail("UNAVAILABLE");
  return `cas/sha256/${digest}`;
};
const context = (row: Pick<ArtifactManifest, "upload_id" | "fellow_id" | "key_hash" | "request_digest">) =>
  JSON.stringify(["artifact-put-v1", row.upload_id, row.fellow_id, row.key_hash, row.request_digest]);

function translate(error: unknown): never {
  if (error instanceof ArtifactUploadError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ARTIFACT_BUDGET_EXHAUSTED")) return fail("BUDGET");
  if (message.includes("ARTIFACT_AUTHORITY_CHANGED")) return fail("NOT_ALLOWED");
  if (message.includes("ARTIFACT_STATE_CONFLICT")) return fail("CONFLICT");
  return fail("UNAVAILABLE");
}

/** Recheck current credential, grant and membership even for readback. A
 * closed session does not erase its private artifacts; a removed membership,
 * expired grant or revoked token cannot keep reading through an old manifest. */
export async function readArtifactManifest(
  db: D1Database, actor: ArtifactActor, uploadId: string, now = Date.now(),
): Promise<ArtifactManifest> {
  const row = await db.prepare(`SELECT a.* FROM artifact_uploads a
    JOIN problem_memberships m ON m.problem_id = a.problem_id AND m.fellow_id = a.fellow_id
    JOIN fellow_tokens c ON c.credential_id = ? AND c.fellow_id = a.fellow_id AND c.sponsor_id = a.sponsor_id
    JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id AND f.sponsor_id = c.sponsor_id
      AND f.status IN ('active', 'suspicious_review')
    JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
      AND g.granted_scopes_json = c.granted_scopes_json AND g.granted_resources_json = c.granted_resources_json
    WHERE a.upload_id = ? AND a.fellow_id = ? AND a.sponsor_id = ?
      AND c.revoked_at IS NULL AND c.issued_at <= ? AND c.expires_at > ?
      AND c.credential_profile = 'bearer'
      AND NOT EXISTS (SELECT 1 FROM enrollment_sponsor_security sec
        WHERE sec.sponsor_id = c.sponsor_id AND sec.panic_at >= c.issued_at)
      AND (json_extract(c.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
        OR json_extract(c.granted_resources_json, '$.fellowGrantExpiresAt') > ?)
      AND (json_extract(c.granted_resources_json, '$.problemBinding') IS NULL
        OR json_extract(c.granted_resources_json, '$.problemBinding') = a.problem_id)`)
    .bind(actor.credentialId, uploadId, actor.fellowId, actor.sponsorId, now, now, now).first<ArtifactManifest>();
  return row ?? fail("NOT_FOUND");
}

export async function declareArtifact(
  db: D1Database, codec: ArtifactReplayCodec, signing: ArtifactSigningConfig,
  actor: ArtifactActor, input: ArtifactDeclaration, idempotencyKey: string,
  clock: () => number = Date.now,
  authorizeNew?: (problemId: string) => Promise<void>,
): Promise<ArtifactCreated> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size < 1 ||
    (input.encoding !== "text" && input.encoding !== "lake-archive") ||
    input.size > (input.encoding === "text" ? 5 : 20) * 1024 * 1024) return fail("MISMATCH");
  const keyHash = await artifactSha256(encode(idempotencyKey));
  const requestDigest = await artifactSha256(encode(JSON.stringify([
    input.sessionId, input.sha256, input.size, input.encoding,
  ])));
  async function replay(): Promise<ArtifactCreated | undefined> {
    const prior = await db.prepare("SELECT * FROM artifact_uploads WHERE fellow_id = ? AND key_hash = ?")
      .bind(actor.fellowId, keyHash).first<ArtifactManifest>();
    if (!prior) return undefined;
    if (prior.request_digest !== requestDigest || prior.credential_id !== actor.credentialId ||
      prior.sponsor_id !== actor.sponsorId) return fail("CONFLICT");
    await readArtifactManifest(db, actor, prior.upload_id, clock());
    if (clock() >= prior.expires_at) return fail("EXPIRED");
    const decoded = JSON.parse(await codec.open({ ciphertext: prior.replay_ciphertext,
      initializationVector: prior.replay_iv }, context(prior))) as ArtifactCreated;
    if (decoded.upload_id !== prior.upload_id || decoded.sha256 !== prior.sha256 ||
      decoded.size_bytes !== prior.size_bytes || decoded.put.expires_at !== prior.put_expires_at) return fail("UNAVAILABLE");
    return decoded;
  }
  try {
    const existing = await replay();
    if (existing) return existing;
    const session = await db.prepare("SELECT problem_id FROM sessions WHERE session_id = ? AND fellow_id = ?")
      .bind(input.sessionId, actor.fellowId).first<{ problem_id: string }>();
    if (!session) return fail("NOT_FOUND");
    await authorizeNew?.(session.problem_id);
    const createdAt = clock();
    const uploadId = id();
    const put = await presignArtifactPut(signing, uploadId, input.size, createdAt);
    const receipt: ArtifactCreated = { upload_id: uploadId, sha256: input.sha256, size_bytes: input.size,
      encoding: input.encoding, created_at: createdAt, expires_at: createdAt + ARTIFACT_REPLAY_MS,
      storage: "private", put };
    const sealed = await codec.seal(JSON.stringify(receipt), context({ upload_id: uploadId,
      fellow_id: actor.fellowId, key_hash: keyHash, request_digest: requestDigest }));
    await db.prepare(`INSERT INTO artifact_uploads (upload_id, fellow_id, credential_id, sponsor_id,
      session_id, problem_id, sha256, size_bytes, encoding, created_at, updated_at, expires_at,
      put_expires_at, key_hash, request_digest, replay_ciphertext, replay_iv,
      sponsor_daily_bytes, fellow_daily_manifests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uploadId, actor.fellowId, actor.credentialId, actor.sponsorId, input.sessionId,
        session.problem_id, input.sha256, input.size, input.encoding, createdAt, clock(), receipt.expires_at,
        put.expires_at, keyHash, requestDigest, sealed.ciphertext, sealed.initializationVector,
        signing.sponsorDailyBytes, signing.fellowDailyManifests).run();
    return receipt;
  } catch (error) {
    // Concurrent same-key admission may hit quota/uniqueness after another
    // caller commits. Return its exact sealed grant, never sign another URL.
    try { const raced = await replay(); if (raced) return raced; } catch (replayError) {
      if (replayError instanceof ArtifactUploadError) throw replayError;
    }
    return translate(error);
  }
}

/** Bound both the storage promise and stream, retiring a late response body.
 * No error includes a bucket key, uploaded content, URL or credential. */
type StreamReader = {
  read(): Promise<{ done: boolean; value?: any }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

async function readBytes(bucket: R2Bucket, key: string, expectedSize: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 20 * 1024 * 1024) return fail("UNAVAILABLE");
  let reader: StreamReader | undefined;
  let expired = false;
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    expired = true;
    void reader?.cancel().catch(() => undefined);
    rejectDeadline(new ArtifactUploadError("UNAVAILABLE"));
  }, ARTIFACT_STORAGE_TIMEOUT_MS);
  try {
    const pending = bucket.get(key);
    void pending.then(value => { if (expired) void value?.body.cancel().catch(() => undefined); }, () => undefined);
    const object = await Promise.race([pending, deadline]);
    if (object === null) return fail("NOT_UPLOADED");
    if (!Number.isSafeInteger(object.size) || object.size !== expectedSize) {
      void object.body.cancel().catch(() => undefined);
      return fail("MISMATCH");
    }
    const activeReader = object.body.getReader();
    reader = activeReader;
    const bytes = new Uint8Array(expectedSize);
    let offset = 0;
    for (;;) {
      const next = await Promise.race([activeReader.read(), deadline]);
      if (next.done) break;
      if (offset + next.value.byteLength > expectedSize) return fail("MISMATCH");
      bytes.set(next.value, offset); offset += next.value.byteLength;
    }
    if (offset !== expectedSize) return fail("MISMATCH");
    return bytes;
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    return translate(error);
  } finally { clearTimeout(timer); reader?.releaseLock(); }
}

async function putVerifiedBytes(bucket: R2Bucket, key: string, bytes: Uint8Array, digest: string, contentType: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const written = await Promise.race([
      bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest,
        httpMetadata: { contentType, contentDisposition: "attachment", cacheControl: "private, no-store" } }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ArtifactUploadError("UNAVAILABLE")), ARTIFACT_STORAGE_TIMEOUT_MS); }),
    ]);
    if (written === null) {
      // A pre-existing CAS inconsistency is an operational failure, not a
      // reason to quarantine this uploader's correctly verified bytes.
      try {
        const existing = await readBytes(bucket, key, bytes.length);
        if (await artifactSha256(existing) !== digest) return fail("UNAVAILABLE");
      } catch { return fail("UNAVAILABLE"); }
    }
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function completeArtifact(
  db: D1Database, bucket: R2Bucket, actor: ArtifactActor, uploadId: string,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
): Promise<ArtifactManifest> {
  const row = await readArtifactManifest(db, actor, uploadId, clock());
  if (row.state === "verified") return row;
  if (row.state === "quarantined") return fail("CONTENT_REFUSED");
  const now = clock();
  if (row.state === "expired" || now >= row.expires_at) {
    await db.prepare(`UPDATE artifact_uploads SET state = 'expired', updated_at = ?, lease_token = NULL, lease_until = NULL
      WHERE upload_id = ? AND state = 'presigned' AND expires_at <= ?`).bind(now, uploadId, now).run();
    return fail("EXPIRED");
  }
  if (row.credential_id !== actor.credentialId) return fail("NOT_ALLOWED");
  await authorizeNew?.(row);
  const token = crypto.randomUUID().replaceAll("-", "");
  try {
    const leased = await db.prepare(`UPDATE artifact_uploads SET lease_token = ?, lease_until = ?, updated_at = ?
      WHERE upload_id = ? AND state = 'presigned' AND expires_at > ?
        AND (lease_until IS NULL OR lease_until <= ?) RETURNING upload_id`)
      .bind(token, now + ARTIFACT_VERIFY_LEASE_MS, now, uploadId, now, now).first();
    if (!leased) {
      const winner = await readArtifactManifest(db, actor, uploadId, clock());
      if (winner.state === "verified") return winner;
      return fail("BUSY");
    }
    const bytes = await readBytes(bucket, artifactStagingKey(uploadId), row.size_bytes);
    const inspected = await inspectArtifact(bytes, row.encoding, row.sha256);
    // Private CAS only. There is no automatic public publication or evidence
    // binding. A failed final DB transaction can leave only a private orphan.
    await putVerifiedBytes(bucket, casKey(row.sha256), bytes, row.sha256, inspected.contentType);
    const finished = clock();
    const committed = await db.prepare(`UPDATE artifact_uploads SET state = 'verified', content_type = ?,
      inspected_members = ?, expanded_bytes = ?, verified_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
      WHERE upload_id = ? AND state = 'presigned' AND lease_token = ? AND lease_until > ? AND expires_at > ? RETURNING *`)
      .bind(inspected.contentType, inspected.members, inspected.expandedBytes, finished, finished,
        uploadId, token, finished, finished).first<ArtifactManifest>();
    return committed ?? fail("BUSY");
  } catch (error) {
    if (error instanceof ArtifactInspectionError || (error instanceof ArtifactUploadError && error.code === "MISMATCH")) {
      const mismatch = error instanceof ArtifactUploadError || error.code === "ARTIFACT_DIGEST_MISMATCH";
      const code = mismatch ? "MANIFEST_MISMATCH" : "CONTENT_REFUSED";
      await db.prepare(`UPDATE artifact_uploads SET state = 'quarantined', failure_code = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
        WHERE upload_id = ? AND state = 'presigned' AND lease_token = ?`)
        .bind(code, clock(), uploadId, token).run();
      return fail(mismatch ? "MISMATCH" : "CONTENT_REFUSED");
    }
    return translate(error);
  } finally {
    // A crashed request's lease is reclaimable; a slow old request cannot
    // clear another verifier's lease or alter a terminal manifest.
    try {
      await db.prepare(`UPDATE artifact_uploads SET lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE upload_id = ? AND state = 'presigned' AND lease_token = ?`).bind(clock(), uploadId, token).run();
    } catch { /* The durable lease expires; never mask the original outcome. */ }
  }
}

export async function readVerifiedArtifact(
  db: D1Database, bucket: R2Bucket, actor: ArtifactActor, uploadId: string,
  clock: () => number = Date.now,
) {
  const manifest = await readArtifactManifest(db, actor, uploadId, clock());
  if (manifest.state !== "verified") return fail("NOT_FOUND");
  let bytes: Uint8Array;
  try { bytes = await readBytes(bucket, casKey(manifest.sha256), manifest.size_bytes); }
  catch { return fail("UNAVAILABLE"); }
  if (await artifactSha256(bytes) !== manifest.sha256) return fail("UNAVAILABLE");
  await readArtifactManifest(db, actor, uploadId, clock());
  return { manifest, bytes };
}
