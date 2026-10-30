import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import { openScreeningCase } from "../moderation/store.ts";
import { MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES } from "./artifact-inspection.ts";
import { type PublicationBytes, readPublicationBytes } from "./artifact-publication-bytes.ts";
import {
  livePublicationPin,
  PUBLICATION_LIVE_PIN_SQL,
  type PublicationPin,
  publicationPinBindings,
  publicationScreenContext,
} from "./artifact-publication-outbox.ts";
import {
  ArtifactPublicationError,
  type PublicationJob,
  publicationHash,
  readPublicationJob,
} from "./artifact-publication-store.ts";

const VERSION = "artifact-publication-operator-review-v1";
const sha = /^sha256:[a-f0-9]{64}$/;
const label = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const candidate = (content: PublicationBytes) =>
  JSON.stringify({
    kind: "artifact-publication",
    statement: content.screeningBody,
    falsifier: null,
  });

async function reviewInputDigest(job: PublicationJob, context: string) {
  return publicationHash(
    JSON.stringify({
      version: "artifact-publication-review-v1",
      publication_id: job.publication_id,
      artifact_sha256: job.sha256,
      screening_sha256: job.screening_sha256,
      evidence_sha256: job.evidence_sha256,
      context_digest: context,
    }),
  );
}

async function heldObservation(job: PublicationJob) {
  if (
    job.state !== "held" ||
    !["screening-held", "dependency-unavailable"].includes(job.failure_code ?? "") ||
    job.last_screen_json === null ||
    job.released_at !== null ||
    job.screen_receipt_json !== null
  )
    return null;
  try {
    const r = JSON.parse(job.last_screen_json);
    if (
      r.version !== "artifact-publication-policy-v1" ||
      r.publication_id !== job.publication_id ||
      r.artifact_sha256 !== job.sha256 ||
      r.screening_sha256 !== job.screening_sha256 ||
      r.evidence_sha256 !== job.evidence_sha256 ||
      r.context_digest !== `sha256:${await publicationScreenContext(job)}` ||
      !["ok", "error", "timeout"].includes(r.provider_status) ||
      !["pass", "allow-with-warning", "quarantine", "reject"].includes(r.decision) ||
      (r.provider_status === "ok" && r.decision === "pass") ||
      typeof r.model_version !== "string" ||
      typeof r.policy_version !== "string" ||
      typeof r.configuration_digest !== "string" ||
      !label.test(r.model_version) ||
      !label.test(r.policy_version) ||
      !sha.test(r.configuration_digest) ||
      ![
        "benign-context",
        "spam-commercial",
        "injection",
        "dual-use-boundary",
        "operational-harm",
        "harassment",
        "sexual-content",
        "provider-unavailable",
        "off-topic",
      ].includes(r.coarse_category)
    )
      return null;
    return r as {
      provider_status: "ok" | "error" | "timeout";
      decision: "pass" | "allow-with-warning" | "quarantine" | "reject";
      coarse_category: string;
      model_version: string;
      policy_version: string;
      configuration_digest: string;
    };
  } catch {
    return null;
  }
}

/** Persist the complete bounded screening envelope only in the existing private
 * operator case. Public logs and status expose a case id, never uploaded text.
 * Publication-scoped input identity prevents cross-context approval reuse. */
export async function openArtifactPublicationReview(
  db: D1Database,
  privateBucket: R2Bucket,
  id: string,
  now: number,
  observed?: PublicationBytes,
): Promise<boolean> {
  const job = await readPublicationJob(db, id);
  if (!job || job.review_case_id) return !!job?.review_case_id;
  const observation = await heldObservation(job);
  if (!observation) return false;
  const content = observed ?? (await readPublicationBytes(privateBucket, job));
  if (
    content.artifact.sha256 !== job.sha256 ||
    content.artifact.size !== job.size_bytes ||
    content.artifact.contentType !== job.content_type ||
    content.screeningSha256 !== job.screening_sha256 ||
    new TextEncoder().encode(content.screeningBody).byteLength >
      MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES ||
    !(await livePublicationPin(db, job))
  )
    return false;
  const context = await publicationScreenContext(job);
  const inputDigest = await reviewInputDigest(job, context);
  const candidateJson = candidate(content);
  const candidateDigest = await publicationHash(candidateJson);
  const opened = await openScreeningCase(db, {
    problemId: job.problem_id,
    fellowId: job.fellow_id,
    sponsorId: job.sponsor_id,
    route: "artifact-publications",
    inputDigest,
    contextDigest: context,
    candidate: { kind: "artifact-publication", statement: content.screeningBody, falsifier: null },
    coarseCategory: observation.coarse_category,
    outcome:
      observation.provider_status !== "ok"
        ? "provider-unavailable"
        : observation.decision === "allow-with-warning"
          ? "allow-with-warning"
          : "quarantine",
    decisionPath:
      observation.provider_status === "ok"
        ? "provider-contextual-hold"
        : observation.provider_status === "timeout"
          ? "provider-timeout-fail-closed"
          : "provider-error-fail-closed",
    providerStatus: observation.provider_status,
    modelVersion: observation.model_version,
    policyVersion: observation.policy_version,
    configurationDigest: observation.configuration_digest.slice(7),
  });
  const result = await db
    .prepare(`INSERT INTO artifact_publication_reviews
    (publication_id,case_id,input_digest,context_digest,candidate_digest,observation_json,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM screening_cases c WHERE c.case_id=? AND c.candidate_json=? AND c.contextual_input_json IS NULL
    ) ON CONFLICT(publication_id) DO NOTHING`)
    .bind(
      job.publication_id,
      opened.caseId,
      inputDigest,
      context,
      candidateDigest,
      job.last_screen_json,
      now,
      opened.caseId,
      candidateJson,
    )
    .run();
  if (!result.success) throw new Error("ARTIFACT_PUBLICATION_REVIEW_UNAVAILABLE");
  const saved = await db
    .prepare("SELECT case_id FROM artifact_publication_reviews WHERE publication_id=?")
    .bind(id)
    .first<{ case_id: string }>();
  return saved?.case_id === opened.caseId;
}

/** Repair a crash between holding a job and opening its case. Failed private
 * reads back off independently; they cannot monopolize every scheduled batch. */
export async function reconcileArtifactPublicationReviews(
  db: D1Database,
  privateBucket: R2Bucket,
  origin: string,
  now: number,
  limit: number,
): Promise<void> {
  const rows = await db
    .prepare(`SELECT j.publication_id FROM artifact_publication_jobs j
    JOIN artifact_publications b USING(publication_id)
    LEFT JOIN artifact_publication_reviews r USING(publication_id)
    LEFT JOIN artifact_publication_review_attempts a USING(publication_id)
    WHERE b.artifact_origin=? AND j.state='held' AND r.publication_id IS NULL
      AND j.failure_code IN ('screening-held','dependency-unavailable') AND j.last_screen_json IS NOT NULL
      AND COALESCE(a.next_attempt_at,0)<=?
    ORDER BY COALESCE(a.next_attempt_at,0),j.updated_at,j.publication_id LIMIT ?`)
    .bind(origin, now, limit)
    .all<{ publication_id: string }>();
  if (!rows.success) throw new Error("ARTIFACT_PUBLICATION_REVIEW_UNAVAILABLE");
  for (const row of rows.results) {
    try {
      if (await openArtifactPublicationReview(db, privateBucket, row.publication_id, now)) continue;
    } catch {
      /* Missing bytes or a racing hold remain private and retryable. */
    }
    await db
      .prepare(`INSERT INTO artifact_publication_review_attempts(publication_id,attempts,next_attempt_at)
      VALUES (?,1,?) ON CONFLICT(publication_id) DO UPDATE SET
      attempts=MIN(attempts+1,1000000),next_attempt_at=?+MIN(3600000,60000*(1 << MIN(attempts,6)))`)
      .bind(row.publication_id, now + 60000, now)
      .run();
  }
}

interface ReviewDecision {
  publication_id: string;
  case_id: string;
  input_digest: string;
  context_digest: string;
  candidate_digest: string;
  observation_json: string;
  candidate_json: string;
  contextual_input_json: string | null;
  case_state: "released" | "rejected";
  case_decided_at: string;
  case_decided_by: string;
  case_decision_reason: string;
  decision_kind: "operator" | "operator-appeal";
  appeal_id: string | null;
  audit_event_id: string;
  operator_id: string;
  decided_at: string;
  decision_reason: string;
  after_state_digest: string;
  appeal_decision_digest: string | null;
}
function decisionSnapshot(d: ReviewDecision) {
  return {
    case_id: d.case_id,
    case_state: d.case_state,
    case_decided_at: d.case_decided_at,
    case_decided_by: d.case_decided_by,
    case_decision_reason: d.case_decision_reason,
    decision_kind: d.decision_kind,
    appeal_id: d.appeal_id,
    audit_event_id: d.audit_event_id,
    operator_id: d.operator_id,
    decided_at: d.decided_at,
    decision_reason: d.decision_reason,
    after_state_digest: d.after_state_digest,
    appeal_decision_digest: d.appeal_decision_digest,
  };
}
async function readDecision(db: D1Database, job: PublicationJob): Promise<ReviewDecision | null> {
  const rows = await db
    .prepare("SELECT * FROM artifact_publication_review_decisions WHERE publication_id=? LIMIT 2")
    .bind(job.publication_id)
    .all<ReviewDecision>();
  if (!rows.success || rows.results.length !== 1) return null;
  const d = rows.results[0];
  if (!d) return null;
  if (
    d.contextual_input_json !== null ||
    d.observation_json !== job.last_screen_json ||
    d.context_digest !== (await publicationScreenContext(job)) ||
    d.input_digest !== (await reviewInputDigest(job, d.context_digest)) ||
    d.candidate_digest !== (await publicationHash(d.candidate_json))
  )
    return null;
  let c: { kind?: unknown; statement?: unknown; falsifier?: unknown };
  try {
    c = JSON.parse(d.candidate_json);
  } catch {
    return null;
  }
  if (
    c?.kind !== "artifact-publication" ||
    typeof c.statement !== "string" ||
    c.falsifier !== null ||
    new TextEncoder().encode(c.statement).byteLength > MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES ||
    (await publicationHash(c.statement)) !== job.screening_sha256
  )
    return null;
  const expected =
    d.decision_kind === "operator"
      ? { case: d.case_id, state: "released" }
      : { appeal: d.appeal_id, state: "released" };
  if (d.after_state_digest !== (await publicationHash(JSON.stringify(expected)))) return null;
  return d;
}
function releaseReceipt(
  job: PublicationJob,
  d: ReviewDecision,
  digest: string,
  retryId: string,
  at: number,
) {
  return JSON.stringify({
    version: VERSION,
    publication_id: job.publication_id,
    artifact_sha256: job.sha256,
    screening_sha256: job.screening_sha256,
    evidence_sha256: job.evidence_sha256,
    context_digest: `sha256:${d.context_digest}`,
    case_id: d.case_id,
    input_digest: `sha256:${d.input_digest}`,
    candidate_digest: `sha256:${d.candidate_digest}`,
    decision_kind: d.decision_kind,
    audit_event_id: d.audit_event_id,
    decision_digest: `sha256:${digest}`,
    consent_retry_id: retryId,
    consented_at: at,
  });
}

/** The caller has authorized a current owned session and retained the original
 * consent. Exact private bytes, immutable review, and all live public sources
 * are rechecked before the atomic, separately audited owner authorization. */
export async function authorizeArtifactPublicationReview(input: {
  db: D1Database;
  privateBucket: R2Bucket;
  job: PublicationJob;
  actor: FellowCredentialBinding;
  sessionId: string;
  keyHash: string;
  requestDigest: string;
  pin: PublicationPin;
  now: () => number;
}): Promise<void> {
  const { db, job, actor } = input;
  const content = await readPublicationBytes(input.privateBucket, job);
  const d = await readDecision(db, job);
  if (
    !d ||
    candidate(content) !== d.candidate_json ||
    content.screeningSha256 !== job.screening_sha256 ||
    content.artifact.contentType !== job.content_type
  )
    throw new ArtifactPublicationError("CONFLICT");
  const decisionDigest = await publicationHash(JSON.stringify(decisionSnapshot(d)));
  const at = input.now(),
    retryId = `APR-${crypto.randomUUID().replaceAll("-", "")}`;
  const row = {
    retry_id: retryId,
    publication_id: job.publication_id,
    retry_generation: job.retry_generation,
    fellow_id: actor.fellowId,
    sponsor_id: actor.sponsorId,
    credential_id: actor.credentialId,
    session_id: input.sessionId,
    key_hash: input.keyHash,
    request_digest: input.requestDigest,
    created_at: at,
    held_at: job.updated_at,
    prior_attempts: job.attempts,
    prior_screen_attempts: job.screen_attempts,
    prior_last_screen_json: job.last_screen_json,
    target_event_id: input.pin.evidence.target_event_id,
    target_sha256: input.pin.evidence.target_sha256,
    case_id: d.case_id,
    decision_kind: d.decision_kind,
    audit_event_id: d.audit_event_id,
    decision_digest: decisionDigest,
    release_receipt_json: releaseReceipt(job, d, decisionDigest, retryId, at),
  };
  const columns = Object.keys(row);
  const saved = await db
    .prepare(`INSERT INTO artifact_publication_review_releases(${columns.join(",")})
    SELECT ${columns.map(() => "?").join(",")} WHERE EXISTS (
      SELECT 1 FROM artifact_publication_review_decisions d WHERE d.publication_id=?
        AND d.case_id=? AND d.candidate_json=? AND d.audit_event_id=? AND d.decision_kind=?
        AND d.case_state=? AND d.case_decided_at=? AND d.case_decided_by=? AND d.case_decision_reason=?
        AND d.appeal_id IS ? AND d.operator_id=? AND d.decided_at=? AND d.decision_reason=?
        AND d.after_state_digest=? AND d.appeal_decision_digest IS ?
    ) AND ${PUBLICATION_LIVE_PIN_SQL}`)
    .bind(
      ...Object.values(row),
      job.publication_id,
      d.case_id,
      d.candidate_json,
      d.audit_event_id,
      d.decision_kind,
      d.case_state,
      d.case_decided_at,
      d.case_decided_by,
      d.case_decision_reason,
      d.appeal_id,
      d.operator_id,
      d.decided_at,
      d.decision_reason,
      d.after_state_digest,
      d.appeal_decision_digest,
      ...publicationPinBindings(job, input.pin),
    )
    .run();
  if (!saved.success || saved.meta.changes !== 1) throw new ArtifactPublicationError("CONFLICT");
}

/** Reconcile an already durable release without reusing a current bearer or
 * spending another classifier attempt. Its exact case and decision must still
 * match; only the immutable recorded owner consent can authorize a public PUT. */
export async function artifactPublicationReviewReceiptValid(
  db: D1Database,
  job: PublicationJob,
): Promise<boolean> {
  const r = await db
    .prepare(`SELECT retry_id,created_at,case_id,audit_event_id,decision_digest,release_receipt_json
    FROM artifact_publication_review_releases WHERE publication_id=?`)
    .bind(job.publication_id)
    .first<{
      retry_id: string;
      created_at: number;
      case_id: string;
      audit_event_id: string;
      decision_digest: string;
      release_receipt_json: string;
    }>();
  if (!r || r.release_receipt_json !== job.screen_receipt_json || r.created_at !== job.released_at)
    return false;
  const d = await readDecision(db, job);
  return (
    !!d &&
    d.case_id === r.case_id &&
    d.audit_event_id === r.audit_event_id &&
    (await publicationHash(JSON.stringify(decisionSnapshot(d)))) === r.decision_digest &&
    releaseReceipt(job, d, r.decision_digest, r.retry_id, r.created_at) === r.release_receipt_json
  );
}
