import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { type ArtifactEncoding, artifactSha256 } from "./artifact-inspection.ts";
import { readPublicationBytes } from "./artifact-publication-bytes.ts";
import type { KraterLedgerEventInput, KraterLedgerProjectionPlan } from "./krater.ts";

export const ARTIFACT_PUBLICATION_SCHEMA =
  "https://a.asimposium.org/schemas/artifact-publications.v1.json";
export const PUBLICATION_ID = /^AP-[a-f0-9]{32}$/;
export class ArtifactPublicationError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_ALLOWED" | "CONFLICT" | "UNAVAILABLE") {
    super(`ARTIFACT_PUBLICATION_${code}`);
  }
}
export interface PublicationRequest {
  readonly session_id: string;
  readonly evidence_id: string;
  readonly evidence_digest: string;
  readonly publish: true;
  readonly license: "CC-BY-4.0";
}
export interface PublicationRow {
  publication_id: string;
  event_id: string;
  event_sha256: string;
  upload_id: string;
  problem_id: string;
  evidence_id: string;
  evidence_event_id: string;
  evidence_sha256: string;
  fellow_id: string;
  sponsor_id: string;
  credential_id: string;
  session_id: string;
  reservation_id: string;
  key_hash: string;
  request_digest: string;
  sha256: string;
  size_bytes: number;
  encoding: ArtifactEncoding;
  content_type: "text/plain; charset=utf-8" | "application/gzip";
  screening_sha256: string;
  artifact_origin: string;
  license: "CC-BY-4.0";
  created_at: number;
  event_seq: number;
}
export interface PublicationEvidence {
  problem_id: string;
  evidence_id: string;
  evidence_event_id: string;
  evidence_sha256: string;
  evidence_json: string;
  fellow_id: string;
  sponsor_id: string;
}
export interface PublicationJob extends PublicationRow {
  state: "queued" | "held" | "release-authorized" | "published";
  updated_at: number;
  next_attempt_at: number;
  attempts: number;
  screen_attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  screen_receipt_json: string | null;
  released_at: number | null;
  published_at: number | null;
  delivery_cursor: number | null;
  failure_code: string | null;
}
export const PUBLICATION_JOIN = `SELECT b.*, e.seq AS event_seq, j.state, j.updated_at,
  j.next_attempt_at, j.attempts, j.screen_attempts, j.lease_token, j.lease_until,
  j.screen_receipt_json, j.released_at, j.published_at, j.delivery_cursor, j.failure_code
  FROM artifact_publications b JOIN artifact_publication_jobs j USING(publication_id)
  JOIN events e ON e.id = b.event_id AND e.payload_sha256 = b.event_sha256`;
export const publicationHash = (text: string) => artifactSha256(new TextEncoder().encode(text));
const fail = (code: ArtifactPublicationError["code"]): never => {
  throw new ArtifactPublicationError(code);
};

export function publicationReceipt(row: PublicationRow) {
  return {
    schema: ARTIFACT_PUBLICATION_SCHEMA,
    publication_id: row.publication_id,
    problem_id: row.problem_id,
    event_id: row.event_id,
    seq: row.event_seq,
    sha256: row.sha256,
    evidence_id: row.evidence_id,
    evidence_digest: `sha256:${row.evidence_sha256}`,
    license: row.license,
    verification: "bytes-only" as const,
    initial_delivery: "queued" as const,
    status_path: `/v1/artifact-publications/${row.publication_id}`,
    manifest_path: `/p/${row.problem_id}/artifacts/${row.publication_id}.json`,
  };
}
export function publicationStatus(row: PublicationJob) {
  return {
    ...publicationReceipt(row),
    delivery: row.state,
    release_authorized: row.released_at !== null,
    published_at: row.published_at,
    download_url: row.state === "published" ? `${row.artifact_origin}/sha256/${row.sha256}` : null,
    // No classifier trigger, provider exception or uploaded text crosses this face.
    appeal_path: row.state === "held" ? "/policy.md" : null,
  };
}
export async function readPublicationJob(
  db: D1Database,
  id: string,
): Promise<PublicationJob | null> {
  if (!PUBLICATION_ID.test(id)) return fail("NOT_FOUND");
  return db
    .prepare(`${PUBLICATION_JOIN} WHERE b.publication_id = ?`)
    .bind(id)
    .first<PublicationJob>();
}
export async function readPublicationEvidence(
  db: D1Database,
  problem: string,
  evidence: string,
): Promise<PublicationEvidence> {
  const rows = await db
    .prepare(`SELECT * FROM artifact_publication_evidence
    WHERE problem_id = ? AND evidence_id = ? LIMIT 2`)
    .bind(problem, evidence)
    .all<PublicationEvidence>();
  if (!rows.success || rows.results.length !== 1) return fail("NOT_FOUND");
  const row = rows.results[0]!;
  if ((await publicationHash(row.evidence_json)) !== row.evidence_sha256)
    return fail("UNAVAILABLE");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.evidence_json);
  } catch {
    return fail("UNAVAILABLE");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload.evidence_id !== undefined && payload.evidence_id !== row.evidence_id)
  )
    return fail("UNAVAILABLE");
  return row;
}

/** Internal ports supplied only by the Worker composition root. Tests can
 * exercise the exact projection SQL without claiming a modeled writer is D1. */
export interface PublicationCommandOptions {
  readonly db: D1Database;
  readonly privateBucket: R2Bucket;
  readonly artifactOrigin: string;
  readonly readUpload: (
    actor: FellowCredentialBinding,
    uploadId: string,
    now: number,
  ) => Promise<{
    readonly problem_id: string;
    readonly state: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly encoding: ArtifactEncoding;
    readonly content_type: string | null;
  }>;
  readonly clock?: () => number;
  readonly reserve: (input: {
    fellowId: string;
    sponsorId: string;
    problemId: string;
    sessionId: string;
    route: "artifact.publish";
    idempotencyKey: string;
    requestDigest: string;
    now: number;
  }) => Promise<string>;
  readonly writeLedger: (
    input: KraterLedgerEventInput,
    projection: KraterLedgerProjectionPlan,
  ) => Promise<{ eventId: string; seq: number }>;
}

export async function requestArtifactPublication(
  options: PublicationCommandOptions,
  actor: FellowCredentialBinding,
  uploadId: string,
  input: PublicationRequest,
  key: string,
) {
  const db = options.db,
    now = options.clock ?? Date.now;
  if (
    !/^AU-[a-f0-9]{32}$/.test(uploadId) ||
    !/^S-[A-Za-z0-9]{26}$/.test(input.session_id) ||
    !/^E-[A-Za-z0-9]{1,78}$/.test(input.evidence_id) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.evidence_digest) ||
    input.publish !== true ||
    input.license !== "CC-BY-4.0" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)
  )
    return fail("NOT_ALLOWED");
  if (
    !["https://artifacts.asimposium.org", "https://artifacts-staging.asimposium.org"].includes(
      options.artifactOrigin,
    )
  )
    return fail("UNAVAILABLE");
  const keyHash = await publicationHash(key);
  const digest = await publicationHash(
    JSON.stringify({
      upload_id: uploadId,
      session_id: input.session_id,
      evidence_id: input.evidence_id,
      evidence_digest: input.evidence_digest,
      publish: input.publish,
      license: input.license,
      artifact_origin: options.artifactOrigin,
    }),
  );
  // Reauthenticate through the shared owner-read gate even for a receipt replay.
  // A closed original upload session does not erase a completed private upload.
  const upload = await options.readUpload(actor, uploadId, now());
  const prior = await db
    .prepare(`${PUBLICATION_JOIN} WHERE b.fellow_id = ? AND b.key_hash = ?`)
    .bind(actor.fellowId, keyHash)
    .first<PublicationJob>();
  if (prior) {
    if (prior.request_digest !== digest) return fail("CONFLICT");
    return publicationReceipt(prior);
  }
  if (upload.state !== "verified") return fail("NOT_ALLOWED");
  const session = await db
    .prepare(`SELECT p.status, p.unlisted, m.role,
    (SELECT COUNT(*) FROM events WHERE writer_credential_id = ?) AS events_recorded,
    (SELECT COALESCE(SUM(size_bytes),0) FROM artifact_uploads WHERE fellow_id = ?) AS artifact_bytes
    FROM sessions s JOIN problems p ON p.id = s.problem_id
    JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = s.fellow_id
    WHERE s.session_id = ? AND s.fellow_id = ? AND s.problem_id = ? AND s.closed_at IS NULL
      AND s.opened_at <= ? AND s.idle_close_at > ?`)
    .bind(
      actor.credentialId,
      actor.fellowId,
      input.session_id,
      actor.fellowId,
      upload.problem_id,
      new Date(now()).toISOString(),
      new Date(now()).toISOString(),
    )
    .first<{
      status: string;
      unlisted: number;
      role: "observer" | "contributor" | "steward";
      events_recorded: number;
      artifact_bytes: number;
    }>();
  if (
    !session ||
    ![0, 1].includes(session.unlisted) ||
    !Number.isSafeInteger(session.events_recorded) ||
    !Number.isSafeInteger(session.artifact_bytes)
  )
    return fail("NOT_ALLOWED");
  for (const effect of ["promote", "upload-artifacts"] as const) {
    if (
      authorizeFellowWrite({
        effect,
        credential: actor,
        now: now(),
        artifactBytesRequested: 0,
        target: {
          kind: "existing-problem",
          problemId: upload.problem_id,
          publication: session.status === "private-draft" ? "private-draft" : "published",
          unlisted: session.unlisted === 1,
          membershipRole: session.role,
        },
        usage: {
          eventsRecorded: session.events_recorded,
          artifactBytesRecorded: session.artifact_bytes,
        },
      }).decision !== "allow"
    )
      return fail("NOT_ALLOWED");
  }
  const evidence = await readPublicationEvidence(db, upload.problem_id, input.evidence_id);
  if (
    evidence.fellow_id !== actor.fellowId ||
    evidence.sponsor_id !== actor.sponsorId ||
    `sha256:${evidence.evidence_sha256}` !== input.evidence_digest
  )
    return fail("NOT_ALLOWED");
  // Refuse duplicate bindings before reserving another paid-screening attempt.
  if (
    await db
      .prepare("SELECT 1 FROM artifact_publications WHERE upload_id = ? AND evidence_event_id = ?")
      .bind(uploadId, evidence.evidence_event_id)
      .first()
  )
    return fail("CONFLICT");
  const reservationId = await options.reserve({
    fellowId: actor.fellowId,
    sponsorId: actor.sponsorId,
    problemId: upload.problem_id,
    sessionId: input.session_id,
    route: "artifact.publish",
    idempotencyKey: keyHash,
    requestDigest: digest,
    now: now(),
  });
  // This full inspection precedes the public event. No provider sees private
  // bytes unless the owner has explicitly requested this exact publication.
  const content = await readPublicationBytes(options.privateBucket, upload);
  const id = `AP-${crypto.randomUUID().replaceAll("-", "")}`;
  const eventId = `APE-${crypto.randomUUID().replaceAll("-", "")}`;
  const payload = JSON.stringify({
    publication_id: id,
    evidence_id: evidence.evidence_id,
    evidence_event_id: evidence.evidence_event_id,
    evidence_digest: input.evidence_digest,
    sha256: upload.sha256,
    size_bytes: upload.size_bytes,
    content_type: upload.content_type,
    license: input.license,
    verification: "bytes-only",
    initial_delivery: "queued",
  });
  try {
    await options.writeLedger(
      {
        problemId: upload.problem_id,
        eventId,
        idempotencyKey: `ap:${await publicationHash(`${actor.fellowId}:${keyHash}`)}`,
        requestDigest: digest,
        eventType: "artifact.publication-requested",
        objectKind: "artifact",
        objectId: id,
        objectVersion: 1,
        payloadJson: payload,
        createdAt: new Date(now()).toISOString(),
        attribution: {
          fellowId: actor.fellowId,
          sponsorId: actor.sponsorId,
          sessionId: input.session_id,
          modelSelfDeclared: actor.model,
          harness: actor.harness,
          credentialId: actor.credentialId,
        },
      },
      {
        // Exact bytes are guarded again: a matching digest column alone is not
        // enough if event content changed during storage inspection.
        preconditionSql: ` AND EXISTS (SELECT 1 FROM artifact_publication_evidence
        WHERE evidence_event_id = ? AND evidence_sha256 = ? AND evidence_json = ?)`,
        preconditionBindings: [
          evidence.evidence_event_id,
          evidence.evidence_sha256,
          evidence.evidence_json,
        ],
        statementsAfterEvent: (settlement) => {
          const acceptedAt = now();
          const row = {
            publication_id: id,
            event_id: settlement.eventId,
            event_sha256: settlement.payloadSha256,
            upload_id: uploadId,
            problem_id: upload.problem_id,
            evidence_id: evidence.evidence_id,
            evidence_event_id: evidence.evidence_event_id,
            evidence_sha256: evidence.evidence_sha256,
            fellow_id: actor.fellowId,
            sponsor_id: actor.sponsorId,
            credential_id: actor.credentialId,
            session_id: input.session_id,
            reservation_id: reservationId,
            key_hash: keyHash,
            request_digest: digest,
            sha256: upload.sha256,
            size_bytes: upload.size_bytes,
            encoding: upload.encoding,
            content_type: content.artifact.contentType,
            screening_sha256: content.screeningSha256,
            artifact_origin: options.artifactOrigin,
            license: input.license,
            created_at: acceptedAt,
          };
          const columns = Object.keys(row),
            values = Object.values(row);
          const statements: D1PreparedStatement[] = [
            db
              .prepare(`INSERT INTO artifact_publications (${columns.join(",")}) SELECT ${columns.map(() => "?").join(",")}
            WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`)
              .bind(...values, settlement.eventId),
            db
              .prepare(`UPDATE public_write_attempt_reservations SET status = 'settled_published', settled_at = ?
            WHERE reservation_id = ? AND status = 'reserved'
              AND EXISTS (SELECT 1 FROM artifact_publications WHERE event_id = ?)`)
              .bind(acceptedAt, reservationId, settlement.eventId),
            db
              .prepare(`UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1
            AND EXISTS (SELECT 1 FROM artifact_publications WHERE event_id = ?)`)
              .bind(settlement.eventId),
          ];
          return statements;
        },
      },
    );
  } catch {
    // A raced same-key winner owns its exact binding. Never create a fresh job
    // merely because a response or the losing transaction was interrupted.
    const raced = await db
      .prepare(`${PUBLICATION_JOIN} WHERE b.fellow_id = ? AND b.key_hash = ?`)
      .bind(actor.fellowId, keyHash)
      .first<PublicationJob>();
    if (raced) {
      if (raced.request_digest !== digest) return fail("CONFLICT");
      return publicationReceipt(raced);
    }
    return fail("UNAVAILABLE");
  }
  const saved = await db
    .prepare(`${PUBLICATION_JOIN} WHERE b.fellow_id = ? AND b.key_hash = ?`)
    .bind(actor.fellowId, keyHash)
    .first<PublicationJob>();
  if (!saved || saved.request_digest !== digest) return fail("UNAVAILABLE");
  return publicationReceipt(saved);
}
