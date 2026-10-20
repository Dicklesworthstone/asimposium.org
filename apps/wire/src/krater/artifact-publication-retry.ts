import {
  type ArtifactPublicationRetryRequest,
  ArtifactPublicationRetryRequestSchema,
} from "@asimposium/contracts/artifact-publications";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import {
  livePublicationPin,
  PUBLICATION_LIVE_PIN_SQL,
  publicationPinBindings,
} from "./artifact-publication-outbox.ts";
import {
  ARTIFACT_PUBLICATION_SCHEMA,
  ArtifactPublicationError,
  type PublicationCommandOptions,
  publicationHash,
  publicationRetryEligible,
  readPublicationJob,
} from "./artifact-publication-store.ts";

export type PublicationRetryOptions = Pick<
  PublicationCommandOptions,
  "db" | "artifactOrigin" | "readUpload" | "clock"
>;
interface PublicationRetryRow {
  retry_id: string;
  publication_id: string;
  problem_id: string;
  retry_generation: number;
  request_digest: string;
  created_at: number;
}
const fail = (code: ArtifactPublicationError["code"]): never => {
  throw new ArtifactPublicationError(code);
};
function retryReceipt(row: PublicationRetryRow) {
  return {
    schema: ARTIFACT_PUBLICATION_SCHEMA,
    publication_id: row.publication_id,
    problem_id: row.problem_id,
    retry_id: row.retry_id,
    retry_generation: row.retry_generation,
    requeued_at: row.created_at,
    initial_delivery: "queued" as const,
    status_path: `/v1/artifact-publications/${row.publication_id}`,
  };
}

/** Requeue existing, unreleased consent. The INSERT's guards, enqueue and audit
 * triggers execute atomically; no new event, quota reservation or bytes exist.
 * The body selects a recovery generation, never replacement content or policy. */
export async function retryArtifactPublication(
  options: PublicationRetryOptions,
  actor: FellowCredentialBinding,
  publicationId: string,
  input: ArtifactPublicationRetryRequest,
  key: string,
) {
  if (
    !ArtifactPublicationRetryRequestSchema.safeParse(input).success ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)
  )
    return fail("NOT_ALLOWED");
  if (
    !["https://artifacts.asimposium.org", "https://artifacts-staging.asimposium.org"].includes(
      options.artifactOrigin,
    )
  )
    return fail("UNAVAILABLE");
  const db = options.db,
    now = options.clock ?? Date.now;
  const job = await readPublicationJob(db, publicationId);
  if (
    !job ||
    job.fellow_id !== actor.fellowId ||
    job.sponsor_id !== actor.sponsorId ||
    job.artifact_origin !== options.artifactOrigin
  )
    return fail("NOT_FOUND");
  // This current owner-read gate also protects old receipts. A closed recovery
  // session is irrelevant to replay; removed membership or revoked authority is not.
  const upload = await options.readUpload(actor, job.upload_id, now());
  const keyHash = await publicationHash(key);
  const digest = await publicationHash(
    JSON.stringify({
      operation: "artifact-publication-retry-v1",
      publication_id: publicationId,
      artifact_origin: options.artifactOrigin,
      session_id: input.session_id,
      expected_retry_generation: input.expected_retry_generation,
    }),
  );
  const replay = async () => {
    const row = await db
      .prepare(`SELECT r.retry_id,r.publication_id,r.retry_generation,
      r.request_digest,r.created_at,b.problem_id FROM artifact_publication_retries r
      JOIN artifact_publications b USING(publication_id)
      WHERE r.fellow_id = ? AND r.key_hash = ?`)
      .bind(actor.fellowId, keyHash)
      .first<PublicationRetryRow>();
    if (!row) return null;
    // Hashing and receipt lookup may have yielded since the first owner read.
    // Even a raced winner must not disclose history after current access loss.
    await options.readUpload(actor, job.upload_id, now());
    if (row.request_digest !== digest || row.publication_id !== publicationId)
      return fail("CONFLICT");
    return retryReceipt(row);
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    if (!publicationRetryEligible(job) || job.retry_generation !== input.expected_retry_generation)
      return fail("CONFLICT");
    if (
      upload.state !== "verified" ||
      upload.problem_id !== job.problem_id ||
      upload.sha256 !== job.sha256 ||
      upload.size_bytes !== job.size_bytes ||
      upload.encoding !== job.encoding ||
      upload.content_type !== job.content_type
    )
      return fail("NOT_ALLOWED");
    const at = now();
    const session = await db
      .prepare(`SELECT p.status,p.unlisted,m.role,
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
        job.problem_id,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
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
      !["observer", "contributor", "steward"].includes(session.role) ||
      !Number.isSafeInteger(session.events_recorded) ||
      !Number.isSafeInteger(session.artifact_bytes)
    )
      return fail("NOT_ALLOWED");
    if (
      authorizeFellowWrite({
        effect: "artifact.publication-retry",
        credential: actor,
        now: at,
        target: {
          kind: "existing-problem",
          problemId: job.problem_id,
          publication: session.status === "private-draft" ? "private-draft" : "published",
          unlisted: session.unlisted === 1,
          membershipRole: session.role,
          action: "evidence",
        },
        usage: {
          eventsRecorded: session.events_recorded,
          artifactBytesRecorded: session.artifact_bytes,
        },
      }).decision !== "allow"
    )
      return fail("NOT_ALLOWED");
    const pin = await livePublicationPin(db, job);
    if (!pin) return fail("CONFLICT");
    const acceptedAt = now();
    const row = {
      retry_id: `APR-${crypto.randomUUID().replaceAll("-", "")}`,
      publication_id: publicationId,
      retry_generation: job.retry_generation + 1,
      fellow_id: actor.fellowId,
      sponsor_id: actor.sponsorId,
      credential_id: actor.credentialId,
      session_id: input.session_id,
      key_hash: keyHash,
      request_digest: digest,
      created_at: acceptedAt,
      held_at: job.updated_at,
      prior_attempts: job.attempts,
      prior_screen_attempts: job.screen_attempts,
      prior_last_screen_json: job.last_screen_json,
      target_event_id: pin.evidence.target_event_id,
      target_sha256: pin.evidence.target_sha256,
    };
    const columns = Object.keys(row),
      values = Object.values(row);
    const saved = await db
      .prepare(`INSERT INTO artifact_publication_retries (${columns.join(",")})
      SELECT ${columns.map(() => "?").join(",")} WHERE EXISTS (
        SELECT 1 FROM artifact_publication_jobs j WHERE j.publication_id = ? AND j.state = 'held'
          AND j.failure_code = 'binding-unavailable' AND j.retry_generation = ? AND j.updated_at = ?
      ) AND ${PUBLICATION_LIVE_PIN_SQL}`)
      .bind(
        ...values,
        publicationId,
        job.retry_generation,
        job.updated_at,
        ...publicationPinBindings(job, pin),
      )
      .run();
    if (!saved.success || saved.meta.changes !== 1) {
      const winner = await replay();
      if (winner) return winner;
      return fail("CONFLICT");
    }
    const receipt = await replay();
    return receipt ?? fail("UNAVAILABLE");
  } catch (error) {
    // An identical concurrent request may have committed while the losing
    // request was hashing or observing mutable authority. Its receipt wins.
    const winner = await replay();
    if (winner) return winner;
    if (error instanceof ArtifactPublicationError) throw error;
    if (
      error instanceof Error &&
      /ARTIFACT_PUBLICATION_(?:RETRY_REFUSED|STATE_CONFLICT)/.test(error.message)
    )
      return fail("CONFLICT");
    return fail("UNAVAILABLE");
  }
}
