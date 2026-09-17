import {
  ArtifactPublicationRequestSchema, ArtifactPublicationReceiptSchema, ArtifactPublicationStatusSchema,
  PublicArtifactManifestSchema, EvidenceArtifactsSchema,
} from "@asimposium/contracts/artifact-publications";
import { isTrustedStoaOrigin } from "@asimposium/contracts";
import { cancelUnconsumedRequestBody } from "../auth/http.ts";
import { validatedProblem } from "../http/envelope.ts";
import { checkAndReserveQuota, parseSponsorLimit } from "../sessions/quota.ts";
import {
  WorkersAIScreeningProvider, WORKERS_AI_MODEL_VERSION, WORKERS_AI_POLICY_VERSION,
  workersAIConfigurationDigest, type WorkersAiBinding,
} from "../screening/workers-ai.ts";
import { artifactPublicationOrigin } from "./artifact-publication-bytes.ts";
import { artifactAuthority, type ArtifactRuntimeEnv } from "./artifact-runtime.ts";
import { ArtifactUploadError, readArtifactManifest } from "./artifact-store.ts";
import { writeLedgerEvent } from "./krater.ts";
import {
  ArtifactPublicationError, publicationHash, publicationStatus, readPublicationJob,
  requestArtifactPublication, type PublicationCommandOptions,
} from "./artifact-publication-store.ts";
import { readEvidenceArtifacts, readPublicArtifactManifest } from "./artifact-publication-read.ts";
import { drainArtifactPublications, publicationScreenContext } from "./artifact-publication-outbox.ts";
import { screenBoundArtifact, PUBLICATION_SCREEN_BYTES } from "./artifact-publication-screen.ts";
import {
  artifactPublicationRoute, handleArtifactPublicationHttp, PublicationHttpError,
  type PublicationHttpOperations,
} from "./artifact-publication-http.ts";

function originFor(env: ArtifactRuntimeEnv): string {
  const origin = artifactPublicationOrigin(env.STOA_ORIGIN);
  if (origin === undefined) throw new PublicationHttpError("UNAVAILABLE");
  return origin;
}
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof PublicationHttpError) throw error;
    if (error instanceof ArtifactPublicationError) {
      throw new PublicationHttpError(error.code === "NOT_ALLOWED" ? "DENIED" : error.code);
    }
    if (error instanceof ArtifactUploadError) {
      if (error.code === "NOT_FOUND" || error.code === "NOT_ALLOWED") throw new PublicationHttpError("NOT_FOUND");
      if (error.code === "CONTENT_REFUSED") throw new PublicationHttpError("DENIED");
    }
    throw new PublicationHttpError("UNAVAILABLE");
  }
}

/** Real production dependencies, constructed lazily by operation. Anonymous
 * provenance reads do not require an enrollment key, signing key or AI call. */
export function artifactPublicationOperations(env: ArtifactRuntimeEnv): PublicationHttpOperations {
  return {
    problem: validatedProblem,
    authenticate: token => artifactAuthority(env).service.credentialBinding(token),
    decodeRequest(value) { const parsed = ArtifactPublicationRequestSchema.safeParse(value); return parsed.success ? parsed.data : undefined; },
    publish: (actor, upload, input, key) => mapped(async () => {
      const artifactOrigin = originFor(env);
      const reserve: PublicationCommandOptions["reserve"] = async params => {
        const result = await checkAndReserveQuota(env.DB, {
          ...params, sponsorLimit: parseSponsorLimit(env.SPONSOR_PROMOTION_RATE_LIMIT),
        });
        if (!result.allowed) {
          if (result.reason === "RATE_LIMITED") throw new PublicationHttpError("THROTTLED", result.retryAfterSeconds);
          if (result.reason === "IN_FLIGHT_CONFLICT") throw new PublicationHttpError("BUSY", result.retryAfterSeconds);
          throw new PublicationHttpError("CONFLICT");
        }
        return result.reservation.reservationId;
      };
      const receipt = await requestArtifactPublication({ db: env.DB, privateBucket: env.ARTIFACTS,
        artifactOrigin, reserve,
        readUpload: (owner, id, now) => readArtifactManifest(env.DB, owner, id, now),
        writeLedger: (event, projection) => writeLedgerEvent(env.DB, event, projection),
      }, actor, upload, input, key);
      return ArtifactPublicationReceiptSchema.parse(receipt);
    }),
    status: (actor, id) => mapped(async () => {
      const origin = originFor(env), job = await readPublicationJob(env.DB, id);
      if (!job || job.fellow_id !== actor.fellowId || job.artifact_origin !== origin)
        throw new PublicationHttpError("NOT_FOUND");
      // The shared owner-read gate rechecks grant, panic, lifecycle, membership
      // and problem visibility. Knowing an AP id is never private-read authority.
      await readArtifactManifest(env.DB, actor, job.upload_id, Date.now());
      return ArtifactPublicationStatusSchema.parse(publicationStatus(job));
    }),
    manifest: (problem, id) => mapped(async () => PublicArtifactManifestSchema.parse(
      (await readPublicArtifactManifest(env.DB, originFor(env), problem, id)).face)),
    evidence: (problem, evidence, after, through) => mapped(async () => EvidenceArtifactsSchema.parse(
      await readEvidenceArtifacts(env.DB, originFor(env), problem, evidence, after, through))),
  };
}

export async function artifactPublicationFetch(
  request: Request, env: ArtifactRuntimeEnv, next: () => Response | Promise<Response>,
): Promise<Response> {
  if (artifactPublicationRoute(new URL(request.url).pathname) === undefined) return next();
  try {
    const response = await handleArtifactPublicationHttp(request, artifactPublicationOperations(env));
    if (response) return response;
  } catch { /* Dependency failures never expose a private exception or binding. */ }
  cancelUnconsumedRequestBody(request);
  const response = validatedProblem({ status: 503, code: "INTERNAL_ERROR", title: "Artifact publication unavailable",
    detail: "The artifact publication operation could not be completed safely.",
    fixHint: "Retry the same operation later. Consult the operator if this persists.",
    headers: { "cache-control": "private, no-store", "retry-after": "30", "x-content-type-options": "nosniff" } });
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

/** Called by the existing scheduled Worker, not by GET/HEAD and not by the
 * receipt-returning POST. The durable queue owns all retries and paid screens. */
export async function reconcileArtifactPublications(env: ArtifactRuntimeEnv) {
  const artifactOrigin = artifactPublicationOrigin(env.STOA_ORIGIN);
  if (artifactOrigin === undefined) {
    // Local R2 has no public delivery host; never invent a production URL.
    if (isTrustedStoaOrigin(env.STOA_ORIGIN) && new URL(env.STOA_ORIGIN!).protocol === "http:")
      return { published: 0, held: 0, retry: 0, lost: 0, idle: 0, skipped: "local-no-public-origin" as const };
    throw new Error("ARTIFACT_PUBLICATION_ORIGIN_UNAVAILABLE");
  }
  return drainArtifactPublications({ db: env.DB, privateBucket: env.ARTIFACTS,
    publicBucket: env.PUBLIC_ARTIFACTS, artifactOrigin,
    screen: async (job, content) => {
      // This callback is reached only for a queued, leased, digest-verified
      // publication. A release-authorized retry never depends on AI again.
      const baseConfiguration = await workersAIConfigurationDigest();
      const identity = { model_version: WORKERS_AI_MODEL_VERSION, policy_version: WORKERS_AI_POLICY_VERSION,
        configuration_digest: `sha256:${await publicationHash(JSON.stringify({ scope: "artifact-publication-direct-v1",
          base_configuration_digest: baseConfiguration, max_body_bytes: PUBLICATION_SCREEN_BYTES }))}` };
      return screenBoundArtifact({ body: content.screeningBody, body_digest: `sha256:${job.screening_sha256}`,
        context_digest: `sha256:${await publicationScreenContext(job)}`, identity }, async (bound, signal) => {
        if (env.AI === undefined) throw new Error("ARTIFACT_SCREENING_UNAVAILABLE");
        const provider = new WorkersAIScreeningProvider(env.AI as unknown as WorkersAiBinding, { maxBodyBytes: PUBLICATION_SCREEN_BYTES,
          resolveBody: request => {
            if (request.body_digest !== bound.body_digest || request.context_digest !== bound.context_digest)
              throw new Error("ARTIFACT_SCREENING_BINDING_INVALID");
            return bound.body;
          } });
        return provider.screen({ example_id: "artifact-publication", body_digest: bound.body_digest,
          context_digest: bound.context_digest, identity: { ...bound.identity,
            corpus_revision: "artifact-publication-direct-v1", corpus_digest: bound.body_digest } }, signal);
      });
    },
  });
}
