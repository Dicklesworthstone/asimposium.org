import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { ArtifactInspectionError } from "./artifact-inspection.ts";
import {
  type PublicationBytes,
  putPublicArtifact,
  readPublicationBytes,
} from "./artifact-publication-bytes.ts";
import {
  type PublicationJob,
  publicationHash,
  readPublicationEvidence,
  readPublicationJob,
} from "./artifact-publication-store.ts";

export const PUBLICATION_LEASE_MS = 180_000;
export const PUBLICATION_DRAIN_LIMIT = 4;
export interface PublicationScreenResult {
  readonly decision: "pass" | "allow-with-warning" | "quarantine" | "reject";
  readonly provider_status: "ok" | "error" | "timeout";
  readonly evaluated_body_digest: string;
  readonly evaluated_context_digest: string;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly coarse_category: string;
}
export interface PublicationDrainerOptions {
  readonly db: D1Database;
  readonly privateBucket: R2Bucket;
  readonly publicBucket: R2Bucket;
  readonly artifactOrigin: string;
  readonly clock?: () => number;
  readonly screen: (
    job: PublicationJob,
    content: PublicationBytes,
  ) => Promise<PublicationScreenResult>;
}
const categories = new Set([
  "benign-context",
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
  "provider-unavailable",
]);
const sha = /^sha256:[a-f0-9]{64}$/;
const label = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export const publicationScreenContext = (job: PublicationJob) =>
  publicationHash(
    JSON.stringify({
      scope: "artifact-publication-policy-v1",
      publication_id: job.publication_id,
      artifact_origin: job.artifact_origin,
      license: job.license,
      problem_id: job.problem_id,
      fellow_id: job.fellow_id,
      evidence_event_id: job.evidence_event_id,
      evidence_sha256: job.evidence_sha256,
      artifact_sha256: job.sha256,
      screening_sha256: job.screening_sha256,
    }),
  );

async function screenReceipt(job: PublicationJob, result: PublicationScreenResult) {
  if (
    !result ||
    !["pass", "allow-with-warning", "quarantine", "reject"].includes(result.decision) ||
    !["ok", "error", "timeout"].includes(result.provider_status) ||
    result.evaluated_body_digest !== `sha256:${job.screening_sha256}` ||
    result.evaluated_context_digest !== `sha256:${await publicationScreenContext(job)}` ||
    typeof result.model_version !== "string" ||
    typeof result.policy_version !== "string" ||
    typeof result.configuration_digest !== "string" ||
    !label.test(result.model_version) ||
    !label.test(result.policy_version) ||
    !sha.test(result.configuration_digest) ||
    !categories.has(result.coarse_category) ||
    (result.decision === "pass" && result.coarse_category === "provider-unavailable")
  ) {
    throw new Error("ARTIFACT_SCREEN_RECEIPT_INVALID");
  }
  // Explicit projection: even a provider adapter that returns extra fields
  // cannot smuggle raw bodies, matched secrets or reasoning into durable state.
  return JSON.stringify({
    version: "artifact-publication-policy-v1",
    publication_id: job.publication_id,
    artifact_sha256: job.sha256,
    screening_sha256: job.screening_sha256,
    evidence_sha256: job.evidence_sha256,
    context_digest: result.evaluated_context_digest,
    decision: result.decision,
    provider_status: result.provider_status,
    model_version: result.model_version,
    policy_version: result.policy_version,
    configuration_digest: result.configuration_digest,
    coarse_category: result.coarse_category,
  });
}

async function releaseReceiptValid(job: PublicationJob): Promise<boolean> {
  if (job.screen_receipt_json === null) return false;
  try {
    const r = JSON.parse(job.screen_receipt_json);
    return (
      r.version === "artifact-publication-policy-v1" &&
      r.publication_id === job.publication_id &&
      r.artifact_sha256 === job.sha256 &&
      r.screening_sha256 === job.screening_sha256 &&
      r.evidence_sha256 === job.evidence_sha256 &&
      r.decision === "pass" &&
      r.provider_status === "ok" &&
      r.context_digest === `sha256:${await publicationScreenContext(job)}` &&
      typeof r.model_version === "string" &&
      label.test(r.model_version) &&
      typeof r.policy_version === "string" &&
      label.test(r.policy_version) &&
      typeof r.configuration_digest === "string" &&
      sha.test(r.configuration_digest)
    );
  } catch {
    return false;
  }
}

/** Both bodies are hashed before the release CAS and compared byte-for-byte
 * inside it. A stale projection or matching hash column alone cannot release. */
export async function livePublicationPin(db: D1Database, job: PublicationJob) {
  const evidence = await readPublicationEvidence(db, job.problem_id, job.evidence_id);
  if (
    evidence.evidence_event_id !== job.evidence_event_id ||
    evidence.evidence_sha256 !== job.evidence_sha256 ||
    evidence.fellow_id !== job.fellow_id ||
    evidence.sponsor_id !== job.sponsor_id
  )
    return null;
  const event = await db
    .prepare(`SELECT c.payload_json FROM events e JOIN event_content c ON c.event_id = e.id
    AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
    WHERE e.id = ? AND e.problem_id = ? AND e.object_kind = 'artifact'
      AND e.type = 'artifact.publication-requested' AND e.object_id = ? AND e.object_version = 1
      AND e.payload_sha256 = ? AND e.actor_fellow_id = ? AND e.actor_sponsor_id = ?
      AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 8192`)
    .bind(
      job.event_id,
      job.problem_id,
      job.publication_id,
      job.event_sha256,
      job.fellow_id,
      job.sponsor_id,
    )
    .first<{ payload_json: string }>();
  if (!event || (await publicationHash(event.payload_json)) !== job.event_sha256) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(event.payload_json);
  } catch {
    return null;
  }
  if (
    !p ||
    p.publication_id !== job.publication_id ||
    p.sha256 !== job.sha256 ||
    p.size_bytes !== job.size_bytes ||
    p.content_type !== job.content_type ||
    p.license !== job.license ||
    p.evidence_id !== job.evidence_id ||
    p.evidence_event_id !== job.evidence_event_id ||
    p.evidence_digest !== `sha256:${job.evidence_sha256}` ||
    p.verification !== "bytes-only"
  )
    return null;
  return { evidence: evidence.evidence_json, event: event.payload_json };
}

async function claim(db: D1Database, id: string, now: number): Promise<PublicationJob | null> {
  // A third crashed screen cannot create an unbounded retry bill. Unlike a
  // queued screen, an authorized public PUT is retried until reconciled.
  await db
    .prepare(`UPDATE artifact_publication_jobs SET state = 'held', failure_code = 'dependency-unavailable',
    updated_at = ?, lease_token = NULL, lease_until = NULL
    WHERE publication_id = ? AND state = 'queued' AND screen_attempts = 3
      AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`)
    .bind(now, id, now, now)
    .run();
  const token = crypto.randomUUID().replaceAll("-", "");
  const result = await db
    .prepare(`UPDATE artifact_publication_jobs SET lease_token = ?, lease_until = ?,
    updated_at = ?, attempts = MIN(attempts + 1,1000000),
    screen_attempts = screen_attempts + CASE WHEN state = 'queued' THEN 1 ELSE 0 END
    WHERE publication_id = ? AND state IN ('queued','release-authorized') AND next_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?) AND (state <> 'queued' OR screen_attempts < 3)`)
    .bind(token, now + PUBLICATION_LEASE_MS, now, id, now, now)
    .run();
  if (!result.success || result.meta.changes !== 1) return null;
  const job = await readPublicationJob(db, id);
  return job?.lease_token === token ? job : null;
}
async function retryOrHold(
  db: D1Database,
  job: PublicationJob,
  now: number,
  code: "dependency-unavailable" | "content-unavailable" | "binding-unavailable" | "screening-held",
  hold: boolean,
  receipt: string | null = null,
): Promise<"held" | "retry" | "lost"> {
  const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts - 1, 6));
  const result = await db
    .prepare(`UPDATE artifact_publication_jobs SET
    state = CASE WHEN state = 'queued' AND (? = 1 OR screen_attempts >= 3) THEN 'held' ELSE state END,
    failure_code = ?, last_screen_json = COALESCE(?,last_screen_json), next_attempt_at = ?, updated_at = ?,
    lease_token = NULL, lease_until = NULL
    WHERE publication_id = ? AND lease_token = ? AND lease_until > ? AND state IN ('queued','release-authorized')`)
    .bind(hold ? 1 : 0, code, receipt, now + delay, now, job.publication_id, job.lease_token, now)
    .run();
  if (!result.success || (result.meta.changes ?? 0) < 1) return "lost";
  return (await readPublicationJob(db, job.publication_id))?.state === "held" ? "held" : "retry";
}

export async function deliverArtifactPublication(
  options: PublicationDrainerOptions,
  id: string,
): Promise<"published" | "held" | "retry" | "lost" | "idle"> {
  if (
    options.privateBucket === options.publicBucket ||
    !["https://artifacts.asimposium.org", "https://artifacts-staging.asimposium.org"].includes(
      options.artifactOrigin,
    )
  ) {
    throw new Error("ARTIFACT_PUBLICATION_BINDINGS_INVALID");
  }
  const db = options.db,
    now = options.clock ?? Date.now;
  const initial = await readPublicationJob(db, id);
  if (!initial || initial.artifact_origin !== options.artifactOrigin) return "idle";
  const job = await claim(db, id, now());
  if (!job) return "idle";
  try {
    const content = await readPublicationBytes(options.privateBucket, job);
    if (
      content.screeningSha256 !== job.screening_sha256 ||
      content.artifact.contentType !== job.content_type
    )
      return retryOrHold(db, job, now(), "content-unavailable", true);
    if (job.state === "queued") {
      const pin = await livePublicationPin(db, job);
      if (!pin) return retryOrHold(db, job, now(), "binding-unavailable", true);
      const observation = await options.screen(job, content);
      const receipt = await screenReceipt(job, observation);
      if (observation.provider_status !== "ok")
        return retryOrHold(db, job, now(), "dependency-unavailable", false, receipt);
      if (observation.decision !== "pass")
        return retryOrHold(db, job, now(), "screening-held", true, receipt);
      const releaseAt = now();
      const released = await db
        .prepare(`UPDATE artifact_publication_jobs SET state = 'release-authorized',
        updated_at = ?, released_at = ?, screen_receipt_json = ?, last_screen_json = ?, failure_code = NULL,
        lease_until = ? WHERE publication_id = ? AND state = 'queued' AND lease_token = ? AND lease_until > ?
        AND EXISTS (SELECT 1 FROM artifact_publication_evidence WHERE evidence_event_id = ?
          AND evidence_sha256 = ? AND evidence_json = ?)
        AND EXISTS (SELECT 1 FROM event_content WHERE event_id = ? AND payload_sha256 = ?
          AND payload_json = ? AND redacted_at IS NULL)`)
        .bind(
          releaseAt,
          releaseAt,
          receipt,
          receipt,
          releaseAt + PUBLICATION_LEASE_MS,
          job.publication_id,
          job.lease_token,
          releaseAt,
          job.evidence_event_id,
          job.evidence_sha256,
          pin.evidence,
          job.event_id,
          job.event_sha256,
          pin.event,
        )
        .run();
      if (!released.success || (released.meta.changes ?? 0) < 1)
        return retryOrHold(db, job, now(), "binding-unavailable", true);
    } else if (!(await releaseReceiptValid(job))) {
      return retryOrHold(db, job, now(), "dependency-unavailable", false);
    }
    // The release boundary is durable. Do not rescreen, undo or claim privacy
    // after an uncertain PUT, even if credentials are subsequently revoked.
    await putPublicArtifact(options.publicBucket, content);
    const finishedAt = now();
    const finished = await db
      .prepare(`UPDATE artifact_publication_jobs SET state = 'published',
      updated_at = ?, published_at = ?, delivery_cursor = (SELECT cursor + 1 FROM public_cursor WHERE singleton = 1),
      failure_code = NULL, lease_token = NULL, lease_until = NULL
      WHERE publication_id = ? AND state = 'release-authorized' AND lease_token = ? AND lease_until > ?`)
      .bind(finishedAt, finishedAt, job.publication_id, job.lease_token, finishedAt)
      .run();
    return finished.success && (finished.meta.changes ?? 0) >= 1 ? "published" : "lost";
  } catch (error) {
    // The SQL decision uses CURRENT state, not the stale job snapshot: even a
    // failure after release authorization can never turn public bytes 'private'.
    return retryOrHold(
      db,
      job,
      now(),
      error instanceof ArtifactInspectionError ? "content-unavailable" : "dependency-unavailable",
      error instanceof ArtifactInspectionError,
    );
  }
}

export async function drainArtifactPublications(options: PublicationDrainerOptions) {
  const now = (options.clock ?? Date.now)();
  const rows = await options.db
    .prepare(`SELECT j.publication_id FROM artifact_publication_jobs j
    JOIN artifact_publications b USING(publication_id)
    WHERE b.artifact_origin = ? AND j.state IN ('queued','release-authorized') AND j.next_attempt_at <= ?
      AND (j.lease_until IS NULL OR j.lease_until <= ?) ORDER BY j.next_attempt_at,j.publication_id LIMIT ${PUBLICATION_DRAIN_LIMIT}`)
    .bind(options.artifactOrigin, now, now)
    .all<{ publication_id: string }>();
  if (!rows.success) throw new Error("ARTIFACT_PUBLICATION_QUEUE_UNAVAILABLE");
  const counts = { published: 0, held: 0, retry: 0, lost: 0, idle: 0 };
  for (const row of rows.results)
    counts[await deliverArtifactPublication(options, row.publication_id)]++;
  return counts;
}
