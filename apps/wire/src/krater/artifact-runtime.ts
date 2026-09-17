import { isTrustedStoaOrigin, isTrustedAgoraOrigin } from "@asimposium/contracts";
import { cancelUnconsumedRequestBody } from "../auth/http.ts";
import { D1EnrollmentStore } from "../enrollment/d1-store.ts";
import { EnrollmentService, enrollmentReplayProtectorFromBase64Url } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { artifactRoute, artifactUnavailable, handleArtifactHttp } from "./artifact-http.ts";
import { artifactSigningForOrigin } from "./artifact-presign.ts";
import type { ArtifactReplayCodec } from "./artifact-store.ts";

/** Optional secret JSON; absent or invalid configuration disables issuance.
 * The R2 key must be restricted to this environment's private ARTIFACTS bucket.
 * Existing verified downloads do not require a signing credential. */
export type ArtifactRuntimeEnv = Env & { readonly ARTIFACT_UPLOAD_SIGNING?: string };
let cached: { db: Env["DB"]; key: string; service: EnrollmentService; codec: ArtifactReplayCodec } | undefined;

function authority(env: ArtifactRuntimeEnv) {
  const key = JSON.stringify([env.STOA_ORIGIN, env.AGORA_ORIGIN, env.ENROLLMENT_REPLAY_KEY]);
  if (cached?.db === env.DB && cached.key === key) return cached;
  const stoaOrigin = env.STOA_ORIGIN;
  const agoraOrigin = env.AGORA_ORIGIN;
  if (!isTrustedStoaOrigin(stoaOrigin) || !isTrustedAgoraOrigin(agoraOrigin)) throw new Error("ARTIFACT_ORIGIN_INVALID");
  const codec = enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY);
  const service = new EnrollmentService({ stoaOrigin, agoraOrigin,
    store: new D1EnrollmentStore(env.DB), replayProtector: codec });
  cached = { db: env.DB, key, codec, service };
  return cached;
}

/** Mounted by the real Worker entrypoint, outside the public-read CORS allowlist.
 * Other routes never construct this authority or depend on artifact settings. */
export async function artifactFetch(
  request: Request, env: ArtifactRuntimeEnv, next: () => Response | Promise<Response>,
): Promise<Response> {
  if (artifactRoute(new URL(request.url).pathname) === undefined) return next();
  try {
    const { service, codec } = authority(env);
    const signing = artifactSigningForOrigin(env.ARTIFACT_UPLOAD_SIGNING, env.STOA_ORIGIN);
    const response = await handleArtifactHttp(request, { db: env.DB, bucket: env.ARTIFACTS, codec,
      ...(signing === undefined ? {} : { signing }), authenticate: token => service.credentialBinding(token) });
    return response ?? artifactUnavailable();
  } catch {
    cancelUnconsumedRequestBody(request);
    return artifactUnavailable();
  }
}
