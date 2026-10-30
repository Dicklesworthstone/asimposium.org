import {
  ARTIFACT_PART_SIZE_BYTES,
  ArtifactResumableProgressSchema,
} from "@asimposium/contracts/artifact-uploads";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  type ArtifactEncoding,
  ArtifactInspectionError,
  artifactSha256,
  inspectArtifact,
} from "./artifact-inspection.ts";
import {
  ARTIFACT_PUT_TTL_SECONDS,
  type ArtifactPutGrant,
  type ArtifactSigningConfig,
  artifactStagingKey,
  presignArtifactPut,
} from "./artifact-presign.ts";

export type ArtifactFailure =
  | "NOT_FOUND"
  | "NOT_ALLOWED"
  | "CONFLICT"
  | "EXPIRED"
  | "BUDGET"
  | "RENEWAL_LIMIT"
  | "BUSY"
  | "NOT_UPLOADED"
  | "MISMATCH"
  | "CONTENT_REFUSED"
  | "UNAVAILABLE";
export class ArtifactUploadError extends Error {
  readonly code: ArtifactFailure;
  constructor(code: ArtifactFailure) {
    super(code);
    this.name = "ArtifactUploadError";
    this.code = code;
  }
}
export interface ArtifactActor {
  fellowId: string;
  credentialId: string;
  sponsorId: string;
}
export interface ArtifactDeclaration {
  sessionId: string;
  sha256: string;
  size: number;
  encoding: ArtifactEncoding;
}
export interface ArtifactReplayCodec {
  seal(
    value: string,
    context: string,
  ): Promise<{ ciphertext: string; initializationVector: string }>;
  open(
    value: { ciphertext: string; initializationVector: string },
    context: string,
  ): Promise<string>;
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
export interface ArtifactRenewed extends ArtifactCreated {
  renewed_at: number;
}
interface ArtifactPutRenewal {
  upload_id: string;
  fellow_id: string;
  credential_id: string;
  sponsor_id: string;
  key_hash: string;
  created_at: number;
  put_expires_at: number;
  replay_ciphertext: string;
  replay_iv: string;
}
export const ARTIFACT_REPLAY_MS = 24 * 60 * 60 * 1000;
export const ARTIFACT_VERIFY_LEASE_MS = 60_000;
export const ARTIFACT_STORAGE_TIMEOUT_MS = 15_000;
export const ARTIFACT_STAGING_RETRY_MS = 5 * 60 * 1000;
const encode = (value: string) => new TextEncoder().encode(value);
const id = () => `AU-${crypto.randomUUID().replaceAll("-", "")}`;
const fail = (code: ArtifactFailure): never => {
  throw new ArtifactUploadError(code);
};
const casKey = (digest: string) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) return fail("UNAVAILABLE");
  return `cas/sha256/${digest}`;
};
const context = (
  row: Pick<ArtifactManifest, "upload_id" | "fellow_id" | "key_hash" | "request_digest">,
) =>
  JSON.stringify([
    "artifact-put-v1",
    row.upload_id,
    row.fellow_id,
    row.key_hash,
    row.request_digest,
  ]);

function translate(error: unknown): never {
  if (error instanceof ArtifactUploadError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ARTIFACT_BUDGET_EXHAUSTED")) return fail("BUDGET");
  if (message.includes("ARTIFACT_RENEWAL_LIMIT")) return fail("RENEWAL_LIMIT");
  if (message.includes("ARTIFACT_AUTHORITY_CHANGED")) return fail("NOT_ALLOWED");
  if (message.includes("ARTIFACT_STATE_CONFLICT")) return fail("CONFLICT");
  return fail("UNAVAILABLE");
}

/** Recheck current credential, grant and membership even for readback. A
 * closed session does not erase its private artifacts; a removed membership,
 * expired grant or revoked token cannot keep reading through an old manifest. */
export async function readArtifactManifest(
  db: D1Database,
  actor: ArtifactActor,
  uploadId: string,
  now = Date.now(),
): Promise<ArtifactManifest> {
  const row = await db
    .prepare(`SELECT a.* FROM artifact_uploads a
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
    .bind(actor.credentialId, uploadId, actor.fellowId, actor.sponsorId, now, now, now)
    .first<ArtifactManifest>();
  return row ?? fail("NOT_FOUND");
}

export async function declareArtifact(
  db: D1Database,
  codec: ArtifactReplayCodec,
  signing: ArtifactSigningConfig,
  actor: ArtifactActor,
  input: ArtifactDeclaration,
  idempotencyKey: string,
  clock: () => number = Date.now,
  authorizeNew?: (problemId: string) => Promise<void>,
): Promise<ArtifactCreated> {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    (input.encoding !== "text" && input.encoding !== "lake-archive") ||
    input.size > (input.encoding === "text" ? 5 : 20) * 1024 * 1024
  )
    return fail("MISMATCH");
  const keyHash = await artifactSha256(encode(idempotencyKey));
  const requestDigest = await artifactSha256(
    encode(JSON.stringify([input.sessionId, input.sha256, input.size, input.encoding])),
  );
  async function replay(): Promise<ArtifactCreated | undefined> {
    const prior = await db
      .prepare("SELECT * FROM artifact_uploads WHERE fellow_id = ? AND key_hash = ?")
      .bind(actor.fellowId, keyHash)
      .first<ArtifactManifest>();
    if (!prior) return undefined;
    if (
      prior.request_digest !== requestDigest ||
      prior.credential_id !== actor.credentialId ||
      prior.sponsor_id !== actor.sponsorId
    )
      return fail("CONFLICT");
    await readArtifactManifest(db, actor, prior.upload_id, clock());
    if (clock() >= prior.expires_at) return fail("EXPIRED");
    const decoded = JSON.parse(
      await codec.open(
        { ciphertext: prior.replay_ciphertext, initializationVector: prior.replay_iv },
        context(prior),
      ),
    ) as ArtifactCreated;
    if (
      decoded.upload_id !== prior.upload_id ||
      decoded.sha256 !== prior.sha256 ||
      decoded.size_bytes !== prior.size_bytes ||
      decoded.put.expires_at !== prior.put_expires_at
    )
      return fail("UNAVAILABLE");
    return decoded;
  }
  try {
    const existing = await replay();
    if (existing) return existing;
    const session = await db
      .prepare("SELECT problem_id FROM sessions WHERE session_id = ? AND fellow_id = ?")
      .bind(input.sessionId, actor.fellowId)
      .first<{ problem_id: string }>();
    if (!session) return fail("NOT_FOUND");
    await authorizeNew?.(session.problem_id);
    const createdAt = clock();
    const uploadId = id();
    const put = await presignArtifactPut(signing, uploadId, input.size, createdAt);
    const receipt: ArtifactCreated = {
      upload_id: uploadId,
      sha256: input.sha256,
      size_bytes: input.size,
      encoding: input.encoding,
      created_at: createdAt,
      expires_at: createdAt + ARTIFACT_REPLAY_MS,
      storage: "private",
      put,
    };
    const sealed = await codec.seal(
      JSON.stringify(receipt),
      context({
        upload_id: uploadId,
        fellow_id: actor.fellowId,
        key_hash: keyHash,
        request_digest: requestDigest,
      }),
    );
    await db
      .prepare(`INSERT INTO artifact_uploads (upload_id, fellow_id, credential_id, sponsor_id,
      session_id, problem_id, sha256, size_bytes, encoding, created_at, updated_at, expires_at,
      put_expires_at, key_hash, request_digest, replay_ciphertext, replay_iv,
      sponsor_daily_bytes, fellow_daily_manifests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        uploadId,
        actor.fellowId,
        actor.credentialId,
        actor.sponsorId,
        input.sessionId,
        session.problem_id,
        input.sha256,
        input.size,
        input.encoding,
        createdAt,
        clock(),
        receipt.expires_at,
        put.expires_at,
        keyHash,
        requestDigest,
        sealed.ciphertext,
        sealed.initializationVector,
        signing.sponsorDailyBytes,
        signing.fellowDailyManifests,
      )
      .run();
    return receipt;
  } catch (error) {
    // Concurrent same-key admission may hit quota/uniqueness after another
    // caller commits. Return its exact sealed grant, never sign another URL.
    try {
      const raced = await replay();
      if (raced) return raced;
    } catch (replayError) {
      if (replayError instanceof ArtifactUploadError) throw replayError;
    }
    return translate(error);
  }
}

const renewalContext = (
  row: Pick<
    ArtifactPutRenewal,
    "upload_id" | "fellow_id" | "credential_id" | "sponsor_id" | "key_hash"
  >,
) =>
  JSON.stringify([
    "artifact-put-renewal-v1",
    row.upload_id,
    row.fellow_id,
    row.credential_id,
    row.sponsor_id,
    row.key_hash,
  ]);

/** Refreshes an existing whole-object PUT, never its byte reservation or its
 * 24-hour completion window. The initial declaration receipt remains exact.
 * Conditional writes retain the same key, so a lost successful PUT is recovered
 * with /complete instead of replacing already staged bytes. */
export async function renewArtifactPut(
  db: D1Database,
  codec: ArtifactReplayCodec,
  signing: ArtifactSigningConfig,
  actor: ArtifactActor,
  uploadId: string,
  idempotencyKey: string,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
): Promise<ArtifactRenewed> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return fail("MISMATCH");
  const keyHash = await artifactSha256(encode(idempotencyKey));
  async function replay(row: ArtifactManifest): Promise<ArtifactRenewed | undefined> {
    const prior = await db
      .prepare("SELECT * FROM artifact_put_renewals WHERE fellow_id = ? AND key_hash = ?")
      .bind(actor.fellowId, keyHash)
      .first<ArtifactPutRenewal>();
    if (!prior) return undefined;
    if (
      prior.upload_id !== uploadId ||
      prior.credential_id !== actor.credentialId ||
      prior.sponsor_id !== actor.sponsorId
    )
      return fail("CONFLICT");
    if (clock() >= row.expires_at) return fail("EXPIRED");
    const decoded = JSON.parse(
      await codec.open(
        { ciphertext: prior.replay_ciphertext, initializationVector: prior.replay_iv },
        renewalContext(prior),
      ),
    ) as ArtifactRenewed;
    if (
      decoded.upload_id !== row.upload_id ||
      decoded.sha256 !== row.sha256 ||
      decoded.size_bytes !== row.size_bytes ||
      decoded.encoding !== row.encoding ||
      decoded.created_at !== row.created_at ||
      decoded.expires_at !== row.expires_at ||
      decoded.renewed_at !== prior.created_at ||
      decoded.put.expires_at !== prior.put_expires_at ||
      decoded.put.expires_at > row.expires_at ||
      !new URL(decoded.put.url).pathname.endsWith(`/incoming/artifacts/${row.upload_id}`)
    )
      return fail("UNAVAILABLE");
    return decoded;
  }
  try {
    const row = await readArtifactManifest(db, actor, uploadId, clock());
    const existing = await replay(row);
    if (existing) return existing;
    if (row.state === "quarantined") return fail("CONTENT_REFUSED");
    if (row.state === "verified") return fail("CONFLICT");
    const now = clock();
    if (row.state === "expired" || now >= row.expires_at) {
      await expireManifest(db, row.upload_id, now);
      return fail("EXPIRED");
    }
    if (row.credential_id !== actor.credentialId) return fail("NOT_ALLOWED");
    if (await readArtifactResumableProgress(db, row)) return fail("CONFLICT");
    await authorizeNew?.(row);
    const createdAt = clock();
    const ttlSeconds = Math.min(
      ARTIFACT_PUT_TTL_SECONDS,
      Math.floor(row.expires_at / 1000) - Math.floor(createdAt / 1000),
    );
    if (ttlSeconds < 1) return fail("EXPIRED");
    const put = await presignArtifactPut(signing, uploadId, row.size_bytes, createdAt, ttlSeconds);
    const receipt: ArtifactRenewed = {
      upload_id: row.upload_id,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      encoding: row.encoding,
      created_at: row.created_at,
      expires_at: row.expires_at,
      storage: "private",
      renewed_at: createdAt,
      put,
    };
    const sealed = await codec.seal(
      JSON.stringify(receipt),
      renewalContext({
        upload_id: uploadId,
        fellow_id: actor.fellowId,
        credential_id: actor.credentialId,
        sponsor_id: actor.sponsorId,
        key_hash: keyHash,
      }),
    );
    // This one insert is the fresh-effect boundary. Its triggers recheck the
    // same current credential/session/grant/lease as completion, bound the
    // number of renewals, and forbid capability expiry past the manifest.
    await db
      .prepare(`INSERT INTO artifact_put_renewals
        (fellow_id, key_hash, upload_id, credential_id, sponsor_id, created_at, authorized_at,
         put_expires_at, replay_ciphertext, replay_iv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        actor.fellowId,
        keyHash,
        uploadId,
        actor.credentialId,
        actor.sponsorId,
        createdAt,
        clock(),
        put.expires_at,
        sealed.ciphertext,
        sealed.initializationVector,
      )
      .run();
    return receipt;
  } catch (error) {
    // Concurrent identical requests return the winning sealed grant even when
    // its insertion filled the renewal limit. Changed targets still conflict.
    try {
      const row = await readArtifactManifest(db, actor, uploadId, clock());
      const winner = await replay(row);
      if (winner) return winner;
    } catch (replayError) {
      if (replayError instanceof ArtifactUploadError) throw replayError;
    }
    return translate(error);
  }
}

async function expireManifest(db: D1Database, uploadId: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE artifact_uploads SET state = 'expired', updated_at = ?,
      lease_token = NULL, lease_until = NULL
      WHERE upload_id = ? AND state = 'presigned' AND expires_at <= ?`)
    .bind(now, uploadId, now)
    .run();
}

/** Bound both the storage promise and stream, retiring a late response body.
 * No error includes a bucket key, uploaded content, URL or credential. */
type StreamReader = {
  read(): Promise<{ done: boolean; value?: any }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

async function readBytes(bucket: R2Bucket, key: string, expectedSize: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 20 * 1024 * 1024)
    return fail("UNAVAILABLE");
  let reader: StreamReader | undefined;
  let expired = false;
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    expired = true;
    void reader?.cancel().catch(() => undefined);
    rejectDeadline(new ArtifactUploadError("UNAVAILABLE"));
  }, ARTIFACT_STORAGE_TIMEOUT_MS);
  try {
    const pending = bucket.get(key);
    void pending.then(
      (value) => {
        if (expired) void value?.body.cancel().catch(() => undefined);
      },
      () => undefined,
    );
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
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== expectedSize) return fail("MISMATCH");
    return bytes;
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    return translate(error);
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

async function putVerifiedBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  contentType: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const written = await Promise.race([
      bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: digest,
        httpMetadata: {
          contentType,
          contentDisposition: "attachment",
          cacheControl: "private, no-store",
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ArtifactUploadError("UNAVAILABLE")),
          ARTIFACT_STORAGE_TIMEOUT_MS,
        );
      }),
    ]);
    if (written === null) {
      // A pre-existing CAS inconsistency is an operational failure, not a
      // reason to quarantine this uploader's correctly verified bytes.
      try {
        const existing = await readBytes(bucket, key, bytes.length);
        if ((await artifactSha256(existing)) !== digest) return fail("UNAVAILABLE");
      } catch {
        return fail("UNAVAILABLE");
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ArtifactUploadedPart {
  part_number: number;
  size_bytes: number;
  sha256: string;
}

function partSize(row: ArtifactManifest, part: number): number {
  if (
    !Number.isInteger(part) ||
    part < 1 ||
    part > Math.ceil(row.size_bytes / ARTIFACT_PART_SIZE_BYTES)
  )
    return fail("MISMATCH");
  return Math.min(ARTIFACT_PART_SIZE_BYTES, row.size_bytes - (part - 1) * ARTIFACT_PART_SIZE_BYTES);
}

function partKey(uploadId: string, part: ArtifactUploadedPart): string {
  if (
    !/^[a-f0-9]{64}$/.test(part.sha256) ||
    !Number.isInteger(part.part_number) ||
    part.part_number < 1 ||
    part.part_number > 4
  )
    return fail("UNAVAILABLE");
  return `${artifactStagingKey(uploadId)}/parts/${part.part_number}/${part.sha256}`;
}

/** Called only after reading the owned manifest. Stored receipts describe
 * acknowledged bytes, never a client's assertion that an upload succeeded. */
export async function readArtifactResumableProgress(db: D1Database, row: ArtifactManifest) {
  const mode = await db
    .prepare("SELECT upload_id FROM artifact_resumable_uploads WHERE upload_id = ?")
    .bind(row.upload_id)
    .first();
  if (!mode) return undefined;
  const parts = (
    await db
      .prepare(
        "SELECT part_number, size_bytes, sha256 FROM artifact_upload_parts WHERE upload_id = ? AND acknowledged_at IS NOT NULL ORDER BY part_number",
      )
      .bind(row.upload_id)
      .all<ArtifactUploadedPart>()
  ).results;
  const total = Math.ceil(row.size_bytes / ARTIFACT_PART_SIZE_BYTES);
  for (const part of parts)
    if (part.size_bytes !== partSize(row, part.part_number)) return fail("UNAVAILABLE");
  return ArtifactResumableProgressSchema.parse({
    protocol: "private-parts-v1",
    part_size_bytes: ARTIFACT_PART_SIZE_BYTES,
    total_parts: total,
    uploaded_parts: parts.map((part) => ({
      ...part,
      offset: (part.part_number - 1) * ARTIFACT_PART_SIZE_BYTES,
    })),
    remaining_parts: Array.from({ length: total }, (_, i) => i + 1)
      .filter((part) => !parts.some((existing) => existing.part_number === part))
      .map((part) => ({
        part_number: part,
        offset: (part - 1) * ARTIFACT_PART_SIZE_BYTES,
        size_bytes: partSize(row, part),
        path: `/v1/artifacts/${row.upload_id}/parts/${part}`,
      })),
  });
}

/** Share the verifier's durable lease so a source can never be selected while
 * completion is reading it. Timed-out writers can leave only private orphans;
 * every R2 part key includes its digest, so acknowledged bytes cannot change. */
async function withArtifactPartLease<T>(
  db: D1Database,
  row: ArtifactManifest,
  clock: () => number,
  work: (token: string) => Promise<T>,
): Promise<T> {
  const now = clock();
  const token = crypto.randomUUID().replaceAll("-", "");
  try {
    const leased = await db
      .prepare(`UPDATE artifact_uploads SET lease_token = ?, lease_until = ?, updated_at = ?
      WHERE upload_id = ? AND state = 'presigned' AND expires_at > ?
        AND (lease_until IS NULL OR lease_until <= ?) RETURNING upload_id`)
      .bind(token, now + ARTIFACT_VERIFY_LEASE_MS, now, row.upload_id, now, now)
      .first();
    if (!leased) return fail("BUSY");
    return await work(token);
  } catch (error) {
    return translate(error);
  } finally {
    try {
      await db
        .prepare(`UPDATE artifact_uploads SET lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE upload_id = ? AND state = 'presigned' AND lease_token = ?`)
        .bind(clock(), row.upload_id, token)
        .run();
    } catch {
      /* The lease expires; an old writer cannot clear a successor. */
    }
  }
}

async function writablePartManifest(
  db: D1Database,
  actor: ArtifactActor,
  uploadId: string,
  clock: () => number,
) {
  const row = await readArtifactManifest(db, actor, uploadId, clock());
  if (row.state === "quarantined") return fail("CONTENT_REFUSED");
  if (row.state === "verified") return fail("CONFLICT");
  if (row.state === "expired" || clock() >= row.expires_at) {
    await expireManifest(db, uploadId, clock());
    return fail("EXPIRED");
  }
  if (row.credential_id !== actor.credentialId) return fail("NOT_ALLOWED");
  return row;
}

export async function startArtifactResumable(
  db: D1Database,
  actor: ArtifactActor,
  uploadId: string,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
): Promise<ArtifactManifest> {
  const owned = await readArtifactManifest(db, actor, uploadId, clock());
  if (await readArtifactResumableProgress(db, owned)) return owned;
  const row = await writablePartManifest(db, actor, uploadId, clock);
  await authorizeNew?.(row);
  await withArtifactPartLease(db, row, clock, async (token) => {
    // A previous identical starter may have won before this lease was taken.
    if (await readArtifactResumableProgress(db, row)) return;
    await db
      .prepare(`INSERT INTO artifact_resumable_uploads (upload_id, credential_id, started_at, lease_token)
      VALUES (?, ?, ?, ?)`)
      .bind(uploadId, actor.credentialId, clock(), token)
      .run();
  });
  return readArtifactManifest(db, actor, uploadId, clock());
}

export async function putArtifactPart(
  db: D1Database,
  bucket: R2Bucket,
  actor: ArtifactActor,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
) {
  const owned = await readArtifactManifest(db, actor, uploadId, clock());
  if (bytes.length !== partSize(owned, partNumber)) return fail("MISMATCH");
  const sha256 = await artifactSha256(bytes);
  const progress = await readArtifactResumableProgress(db, owned);
  if (!progress) return fail("CONFLICT");
  const prior = progress.uploaded_parts.find((part) => part.part_number === partNumber);
  if (prior) {
    if (prior.sha256 !== sha256 || prior.size_bytes !== bytes.length) return fail("CONFLICT");
    return prior;
  }
  const row = await writablePartManifest(db, actor, uploadId, clock);
  await authorizeNew?.(row);
  const part = { part_number: partNumber, size_bytes: bytes.length, sha256 };
  await withArtifactPartLease(db, row, clock, async (token) => {
    const winner = await db
      .prepare(
        "SELECT sha256, size_bytes, acknowledged_at FROM artifact_upload_parts WHERE upload_id = ? AND part_number = ?",
      )
      .bind(uploadId, partNumber)
      .first<{ sha256: string; size_bytes: number; acknowledged_at: number | null }>();
    if (winner) {
      if (winner.sha256 !== sha256 || winner.size_bytes !== bytes.length) return fail("CONFLICT");
      if (winner.acknowledged_at !== null) return;
    } else {
      // The intent is immutable even if storage or acknowledgment fails.
      // One reservation can therefore address at most its declared bytes.
      await db
        .prepare(`INSERT INTO artifact_upload_parts
        (upload_id, part_number, credential_id, sha256, size_bytes, created_at, lease_token)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(uploadId, partNumber, actor.credentialId, sha256, bytes.length, clock(), token)
        .run();
    }
    await putVerifiedBytes(
      bucket,
      partKey(uploadId, part),
      bytes,
      sha256,
      "application/octet-stream",
    );
    const acknowledged = await db
      .prepare(`UPDATE artifact_upload_parts SET acknowledged_at = ?, lease_token = ?
      WHERE upload_id = ? AND part_number = ? AND sha256 = ? AND acknowledged_at IS NULL RETURNING part_number`)
      .bind(clock(), token, uploadId, partNumber, sha256)
      .first();
    if (!acknowledged) return fail("BUSY");
  });
  return { ...part, offset: (partNumber - 1) * ARTIFACT_PART_SIZE_BYTES };
}

async function readStagedArtifactBytes(db: D1Database, bucket: R2Bucket, row: ArtifactManifest) {
  const progress = await readArtifactResumableProgress(db, row);
  if (!progress) return readBytes(bucket, artifactStagingKey(row.upload_id), row.size_bytes);
  if (progress.remaining_parts.length > 0) return fail("NOT_UPLOADED");
  const bytes = new Uint8Array(row.size_bytes);
  // At most four fixed-size parts share one storage deadline. Sequential
  // storage deadlines could outlast the completion lease for a valid upload.
  // Wait for every read to settle before releasing that shared lease.
  const reads = await Promise.allSettled(
    progress.uploaded_parts.map(async (part) => {
      const chunk = await readBytes(bucket, partKey(row.upload_id, part), part.size_bytes);
      if ((await artifactSha256(chunk)) !== part.sha256) return fail("UNAVAILABLE");
      bytes.set(chunk, part.offset);
    }),
  );
  // An acknowledged object's disappearance or corruption is recoverable
  // storage failure, not a reason to quarantine the author's manifest.
  if (reads.some((read) => read.status === "rejected")) return fail("UNAVAILABLE");
  return bytes;
}

export async function completeArtifact(
  db: D1Database,
  bucket: R2Bucket,
  actor: ArtifactActor,
  uploadId: string,
  clock: () => number = Date.now,
  authorizeNew?: (manifest: ArtifactManifest) => Promise<void>,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<ArtifactManifest> {
  const row = await readArtifactManifest(db, actor, uploadId, clock());
  if (row.state === "verified") return row;
  if (row.state === "quarantined") return fail("CONTENT_REFUSED");
  const now = clock();
  if (row.state === "expired" || now >= row.expires_at) {
    await expireManifest(db, uploadId, now);
    return fail("EXPIRED");
  }
  if (row.credential_id !== actor.credentialId) return fail("NOT_ALLOWED");
  await authorizeNew?.(row);
  const token = crypto.randomUUID().replaceAll("-", "");
  try {
    const leased = await db
      .prepare(`UPDATE artifact_uploads SET lease_token = ?, lease_until = ?, updated_at = ?
      WHERE upload_id = ? AND state = 'presigned' AND expires_at > ?
        AND (lease_until IS NULL OR lease_until <= ?) RETURNING upload_id`)
      .bind(token, now + ARTIFACT_VERIFY_LEASE_MS, now, uploadId, now, now)
      .first();
    if (!leased) {
      const winner = await readArtifactManifest(db, actor, uploadId, clock());
      if (winner.state === "verified") return winner;
      return fail("BUSY");
    }
    const bytes = await readStagedArtifactBytes(db, bucket, row);
    const inspected = await inspectArtifact(bytes, row.encoding, row.sha256);
    // Private CAS only. There is no automatic public publication or evidence
    // binding. A failed final DB transaction can leave only a private orphan.
    await putVerifiedBytes(bucket, casKey(row.sha256), bytes, row.sha256, inspected.contentType);
    const finished = clock();
    const committed = await db
      .prepare(`UPDATE artifact_uploads SET state = 'verified', content_type = ?,
      inspected_members = ?, expanded_bytes = ?, verified_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
      WHERE upload_id = ? AND state = 'presigned' AND lease_token = ? AND lease_until > ? AND expires_at > ? RETURNING *`)
      .bind(
        inspected.contentType,
        inspected.members,
        inspected.expandedBytes,
        finished,
        finished,
        uploadId,
        token,
        finished,
        finished,
      )
      .first<ArtifactManifest>();
    if (!committed) return fail("BUSY");
    // The verified bytes now live in the CAS; the per-upload staging copy has
    // no reader left, and keeping it would store every artifact twice.
    await discardStaging(bucket, uploadId, db, clock, waitUntil);
    return committed;
  } catch (error) {
    if (
      error instanceof ArtifactInspectionError ||
      (error instanceof ArtifactUploadError && error.code === "MISMATCH")
    ) {
      const mismatch =
        error instanceof ArtifactUploadError || error.code === "ARTIFACT_DIGEST_MISMATCH";
      const code = mismatch ? "MANIFEST_MISMATCH" : "CONTENT_REFUSED";
      const quarantined = await db
        .prepare(`UPDATE artifact_uploads SET state = 'quarantined', failure_code = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
        WHERE upload_id = ? AND state = 'presigned' AND lease_token = ? RETURNING upload_id`)
        .bind(code, clock(), uploadId, token)
        .first();
      // Refused bytes (possibly secret-shaped) are never read again; do not
      // retain them. Only the verifier that recorded the terminal state discards.
      if (quarantined) await discardStaging(bucket, uploadId, db, clock, waitUntil);
      return fail(mismatch ? "MISMATCH" : "CONTENT_REFUSED");
    }
    return translate(error);
  } finally {
    // A crashed request's lease is reclaimable; a slow old request cannot
    // clear another verifier's lease or alter a terminal manifest.
    try {
      await db
        .prepare(`UPDATE artifact_uploads SET lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE upload_id = ? AND state = 'presigned' AND lease_token = ?`)
        .bind(clock(), uploadId, token)
        .run();
    } catch {
      /* The durable lease expires; never mask the original outcome. */
    }
  }
}

/** Storage acknowledgment is shared by immediate completion cleanup and the
 * scheduled retry. A timed-out R2 request is not cancelled: deletion_pending
 * blocks both a fresh lease and an acknowledged hold until THAT request settles.
 * If its acknowledgment is lost with the Worker, the row stays visibly pending
 * for operator reconciliation; another delete cannot pretend to resolve it. */
export async function clearArtifactStaging(options: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly uploadId: string;
  readonly token: string;
  readonly clock: () => number;
  readonly scheduled: boolean;
  readonly waitUntil?: (task: Promise<unknown>) => void;
}): Promise<boolean> {
  const { db, bucket, uploadId, token, clock, scheduled } = options;
  const parts = await db
    .prepare(`SELECT part_number, size_bytes, sha256 FROM artifact_upload_parts
      WHERE upload_id = ? ORDER BY part_number`)
    .bind(uploadId)
    .all<ArtifactUploadedPart>();
  if (!parts.success || parts.results.length > 4) return fail("UNAVAILABLE");
  const keys = [
    artifactStagingKey(uploadId),
    ...parts.results.map((part) => partKey(uploadId, part)),
  ];
  const now = clock();
  const admitted = await db
    .prepare(`UPDATE artifact_staging_retention SET deletion_pending = 1
      WHERE upload_id = ? AND held = 0 AND deletion_pending = 0
        AND lease_token = ? AND lease_until > ?
        AND EXISTS (SELECT 1 FROM artifact_uploads u
          WHERE u.upload_id = artifact_staging_retention.upload_id
            AND (u.state IN ('verified', 'expired') OR (? = 0 AND u.state = 'quarantined')))
      RETURNING upload_id`)
    .bind(uploadId, token, now, scheduled ? 1 : 0)
    .first<{ upload_id: string }>();
  if (!admitted) return false;
  // The immutable manifest is terminal and parts cannot be added. No new
  // cleanup owner can claim while deletion_pending is set, even on lease expiry.
  const operation = Promise.resolve().then(() => bucket.delete(keys));
  const acknowledgement = operation.then(
    async () => {
      const finished = clock();
      const row = await db
        .prepare(`UPDATE artifact_staging_retention SET deletion_pending = 0,
            last_cleared_at = ?, next_attempt_at = CASE WHEN ? = 1 THEN ? ELSE next_attempt_at END,
            lease_token = NULL, lease_until = NULL
          WHERE upload_id = ? AND held = 0 AND deletion_pending = 1 AND lease_token = ?
          RETURNING upload_id`)
        .bind(finished, scheduled ? 1 : 0, finished + ARTIFACT_REPLAY_MS, uploadId, token)
        .first<{ upload_id: string }>();
      return row !== null;
    },
    async () => {
      await db
        .prepare(`UPDATE artifact_staging_retention SET deletion_pending = 0,
            next_attempt_at = CASE WHEN ? = 1 THEN ? ELSE next_attempt_at END,
            lease_token = NULL, lease_until = NULL
          WHERE upload_id = ? AND deletion_pending = 1 AND lease_token = ?`)
        .bind(scheduled ? 1 : 0, clock() + ARTIFACT_STAGING_RETRY_MS, uploadId, token)
        .run();
      return fail("UNAVAILABLE");
    },
  );
  // Keep the actual provider acknowledgment alive after a request deadline.
  // The caller already reports the timeout; no private exception is logged.
  options.waitUntil?.(acknowledgement.catch(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      acknowledgement,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ArtifactUploadError("UNAVAILABLE")),
          ARTIFACT_STORAGE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A failed cleanup never changes the verified/quarantined outcome. Its queue
 * retains enough state for retry without defeating an existing operator hold. */
async function discardStaging(
  bucket: R2Bucket,
  uploadId: string,
  db: D1Database,
  clock: () => number,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<void> {
  const token = crypto.randomUUID().replaceAll("-", "");
  try {
    const now = clock();
    const leased = await db
      .prepare(`UPDATE artifact_staging_retention SET lease_token = ?, lease_until = ?
        WHERE upload_id = ? AND held = 0 AND deletion_pending = 0
          AND (lease_until IS NULL OR lease_until <= ?) RETURNING upload_id`)
      .bind(token, now + ARTIFACT_VERIFY_LEASE_MS, uploadId, now)
      .first();
    if (!leased) return;
    await clearArtifactStaging({ db, bucket, uploadId, token, clock, scheduled: false, waitUntil });
  } catch {
    /* orphaned staging bytes are private; the scheduled queue remains truthful */
  } finally {
    try {
      await db
        .prepare(`UPDATE artifact_staging_retention SET lease_token = NULL, lease_until = NULL
          WHERE upload_id = ? AND lease_token = ? AND deletion_pending = 0`)
        .bind(uploadId, token)
        .run();
    } catch {
      /* An unacknowledged storage operation must retain its durable ownership. */
    }
  }
}

export async function readVerifiedArtifact(
  db: D1Database,
  bucket: R2Bucket,
  actor: ArtifactActor,
  uploadId: string,
  clock: () => number = Date.now,
) {
  const manifest = await readArtifactManifest(db, actor, uploadId, clock());
  if (manifest.state !== "verified") return fail("NOT_FOUND");
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(bucket, casKey(manifest.sha256), manifest.size_bytes);
  } catch {
    return fail("UNAVAILABLE");
  }
  if ((await artifactSha256(bytes)) !== manifest.sha256) return fail("UNAVAILABLE");
  await readArtifactManifest(db, actor, uploadId, clock());
  return { manifest, bytes };
}
