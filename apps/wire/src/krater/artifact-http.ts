import {
  ARTIFACT_UPLOADS_SCHEMA_ID, ArtifactCompleteRequestSchema, ArtifactDeclareRequestSchema,
  ArtifactDeclareResponseSchema, ArtifactIdempotencyKeySchema, ArtifactStatusResponseSchema,
} from "@asimposium/contracts/artifact-uploads";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { ArtifactSigningConfig } from "./artifact-presign.ts";
import {
  ArtifactUploadError, completeArtifact, declareArtifact, readArtifactManifest, readVerifiedArtifact,
  type ArtifactManifest, type ArtifactReplayCodec,
} from "./artifact-store.ts";

export const ARTIFACT_HTTP_MAX_BODY = 8192;
export const ARTIFACT_HTTP_BODY_TIMEOUT_MS = 10_000;
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer",
};
const EXAMPLE = { method: "POST", path: "/v1/artifacts", headers: {
  "Content-Type": "application/json", "Idempotency-Key": "artifact-upload-1",
}, body: { session_id: `S-${"A".repeat(26)}`, sha256: "0".repeat(64), size_bytes: 120, encoding: "text" } };

type Operation = "declare" | "status" | "complete" | "content";
export function artifactRoute(path: string): { operation: Operation; id: string | null; method: string } | undefined {
  if (path === "/v1/artifacts") return { operation: "declare", id: null, method: "POST" };
  const match = /^\/v1\/artifacts\/(AU-[a-f0-9]{32})(?:\/(complete|content))?$/.exec(path);
  if (!match?.[1]) return undefined;
  const operation = match[2] === "complete" ? "complete" : match[2] === "content" ? "content" : "status";
  return { operation, id: match[1], method: operation === "complete" ? "POST" : "GET" };
}

export interface ArtifactHttpOptions {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly codec: ArtifactReplayCodec;
  readonly signing?: ArtifactSigningConfig;
  /** This is EnrollmentService.credentialBinding in production, never a header hint. */
  readonly authenticate: (token: string) => Promise<FellowCredentialBinding | undefined>;
  readonly clock?: () => number;
}

function contract(status: number, detail: string, extra: Record<string, string> = {}): Response {
  return validatedProblem({ status, code: "SCHEMA_INVALID", title: "Artifact request needs correction",
    detail, fixHint: "Follow the artifact upload schema. Keep the returned PUT URL private; send the file bytes only to that URL.",
    rule: "A5", extensions: { schema: ARTIFACT_UPLOADS_SCHEMA_ID, example: EXAMPLE },
    headers: { ...PRIVATE_HEADERS, ...extra } });
}
function denied(): Response {
  return validatedProblem({ status: 401, code: "UNAUTHORIZED", title: "Private artifact unavailable",
    detail: "This request is not authorized for the private artifact operation.",
    fixHint: "Use a currently valid Fellow credential and an authorized session or upload identifier.", headers: PRIVATE_HEADERS });
}
export function artifactUnavailable(): Response {
  return validatedProblem({ status: 503, code: "INTERNAL_ERROR", title: "Artifact storage unavailable",
    detail: "The artifact operation could not be completed safely.",
    fixHint: "Retry later with the same request and Idempotency-Key. Contact the operator if this persists.",
    headers: { ...PRIVATE_HEADERS, "retry-after": "30" } });
}
function failure(error: unknown): Response {
  if (!(error instanceof ArtifactUploadError)) return artifactUnavailable();
  switch (error.code) {
    case "NOT_FOUND": case "NOT_ALLOWED": return denied();
    case "MISMATCH": return contract(422, "The uploaded bytes do not match the manifest, or the manifest does not match its schema.");
    case "CONFLICT": return contract(409, "The Idempotency-Key or upload state conflicts with an existing operation. Recover the original receipt or start a distinct upload.");
    case "EXPIRED": return contract(410, "The completion or replay window has expired. A new manifest requires a new Idempotency-Key and a live session.");
    case "NOT_UPLOADED": return contract(409, "No file is available at the upload destination. Complete the signed PUT before requesting verification.", { "retry-after": "5" });
    case "BUSY": return contract(409, "Another verification attempt owns this upload. Retry completion without creating another manifest.", { "retry-after": "5" });
    case "BUDGET": return validatedProblem({ status: 429, code: "WRITE_REFUSED", title: "Artifact issuance budget exhausted",
      detail: "No further upload capability was issued. Existing reservations still count toward the issuance budgets.",
      fixHint: "Reuse existing uploads. Rolling reservations age out within a day; an exhausted lifetime grant additionally requires sponsor action.",
      headers: { ...PRIVATE_HEADERS, "retry-after": "86400" } });
    case "CONTENT_REFUSED": return validatedProblem({ status: 403, code: "WRITE_REFUSED", title: "Artifact not admitted",
      detail: "The artifact remains private and was not admitted for use.",
      fixHint: "Consult /policy.md for policy and appeal guidance. Do not repeatedly submit the unchanged artifact.", headers: PRIVATE_HEADERS });
    default: return artifactUnavailable();
  }
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status,
    headers: { ...PRIVATE_HEADERS, "content-type": "application/json; charset=utf-8", ...extra } });
}
function statusView(row: ArtifactManifest, now: number) {
  const verified = row.state === "verified";
  return ArtifactStatusResponseSchema.parse({
    schema: ARTIFACT_UPLOADS_SCHEMA_ID, upload_id: row.upload_id, sha256: row.sha256,
    size_bytes: row.size_bytes, encoding: row.encoding, created_at: row.created_at,
    expires_at: row.expires_at, storage: "private",
    state: row.state === "presigned" && now >= row.expires_at ? "expired" : row.state,
    verification: verified ? "bytes-only" : "not-verified", verified_at: row.verified_at,
    content_type: row.content_type, content_path: verified ? `/v1/artifacts/${row.upload_id}/content` : null,
  });
}

/** Central policy sees actual current usage. A replay is handled before this
 * new-effect gate: it neither reserves bytes again nor extends the PUT expiry. */
async function authorizeNew(options: ArtifactHttpOptions, credential: FellowCredentialBinding,
  problem: string, requested: number, now: number): Promise<void> {
  const row = await options.db.prepare(`SELECT p.status, p.unlisted, m.role,
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = ?) AS event_usage,
      (SELECT COALESCE(SUM(a.size_bytes), 0) FROM artifact_uploads a WHERE a.fellow_id = ?) AS artifact_usage
    FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ? WHERE p.id = ?`)
    .bind(credential.credentialId, credential.fellowId, credential.fellowId, problem)
    .first<{status:string;unlisted:number;role:"observer"|"contributor"|"steward";event_usage:number;artifact_usage:number}>();
  if (!row || !["observer", "contributor", "steward"].includes(row.role) ||
    !Number.isSafeInteger(row.event_usage) || !Number.isSafeInteger(row.artifact_usage)) throw new ArtifactUploadError("NOT_ALLOWED");
  if (authorizeFellowWrite({ effect: "upload-artifacts", credential, now,
    target: { kind: "existing-problem", problemId: problem,
      publication: row.status === "private-draft" ? "private-draft" : "published",
      unlisted: row.unlisted === 1, membershipRole: row.role },
    usage: { eventsRecorded: row.event_usage, artifactBytesRecorded: row.artifact_usage },
    artifactBytesRequested: requested }).decision !== "allow") throw new ArtifactUploadError("NOT_ALLOWED");
}

/** Own the reader so a slow-body deadline can cancel it, including a stream
 * that ignores Request.signal. Only this small JSON manifest is buffered. */
async function body(request: Request): Promise<unknown> {
  const encoding = request.headers.get("content-encoding");
  const length = request.headers.get("content-length");
  if ((encoding !== null && encoding !== "identity") || (length !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > ARTIFACT_HTTP_MAX_BODY))) throw new Error("BODY_INVALID");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("BODY_REQUIRED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("BODY_TIMEOUT"));
    }, ARTIFACT_HTTP_BODY_TIMEOUT_MS);
  });
  try {
    const bytes = new Uint8Array(ARTIFACT_HTTP_MAX_BODY);
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      if (size + next.value.byteLength > bytes.length) throw new Error("BODY_TOO_LARGE");
      bytes.set(next.value, size); size += next.value.byteLength;
    }
    if (length !== null && size !== Number(length)) throw new Error("BODY_INVALID");
    return parseExactJsonBytes(bytes.subarray(0, size));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Actual Request/Response adapter; authentication is always fresh and all
 * public bucket operations are deliberately absent from this private surface. */
export async function handleArtifactHttp(request: Request, options: ArtifactHttpOptions): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = artifactRoute(url.pathname);
  if (!route) return undefined;
  try {
    if (url.search !== "") return contract(400, "Artifact routes accept no query parameters. Credentials belong only in the Authorization header.");
    if (request.method !== route.method) return contract(405, `This artifact operation requires ${route.method}.`, { allow: route.method });
    if (request.headers.has("asimp-service-envelope")) return denied();
    const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1] || match[1].length > 256) return denied();
    const credential = await options.authenticate(match[1]);
    if (!credential || credential.credentialProfile !== "bearer") return denied();
    const clock = options.clock ?? Date.now;
    if (route.operation === "declare" || route.operation === "complete") {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? ""))
        return contract(415, "Send an application/json request body; the file itself is uploaded to the returned R2 PUT URL.");
      const key = ArtifactIdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
      if (!key.success) return contract(400, "Supply a stable Idempotency-Key of 1–128 letters, digits, periods, colons, underscores or hyphens.");
      let value: unknown;
      try { value = await body(request); } catch { return contract(400, "Send complete UTF-8 JSON within the 8 KiB manifest limit and request deadline."); }
      if (route.operation === "declare") {
        const input = ArtifactDeclareRequestSchema.safeParse(value);
        if (!input.success) return contract(422, "Use an owned session, a lowercase SHA-256 digest, exact byte length, and text or lake-archive encoding. Other fields are not accepted.");
        if (options.signing === undefined) return artifactUnavailable();
        const receipt = await declareArtifact(options.db, options.codec, options.signing, credential,
          { sessionId: input.data.session_id, sha256: input.data.sha256, size: input.data.size_bytes, encoding: input.data.encoding }, key.data, clock,
          problem => authorizeNew(options, credential, problem, input.data.size_bytes, clock()));
        return json(ArtifactDeclareResponseSchema.parse({ ...receipt, schema: ARTIFACT_UPLOADS_SCHEMA_ID,
          status_path: `/v1/artifacts/${receipt.upload_id}`, complete_path: `/v1/artifacts/${receipt.upload_id}/complete` }),
          201, { location: `/v1/artifacts/${receipt.upload_id}` });
      }
      if (!ArtifactCompleteRequestSchema.safeParse(value).success) return contract(422, "Completion takes an empty JSON object. The manifest already binds the actor, digest and size.");
      const row = await completeArtifact(options.db, options.bucket, credential, route.id!, clock,
        manifest => authorizeNew(options, credential, manifest.problem_id, 0, clock()));
      return json(statusView(row, clock()));
    }
    if (route.operation === "status") return json(statusView(await readArtifactManifest(options.db, credential, route.id!, clock()), clock()));
    if (request.headers.has("range")) return contract(400, "Private artifact downloads return the complete verified object, not byte ranges.");
    const result = await readVerifiedArtifact(options.db, options.bucket, credential, route.id!, clock);
    return new Response(result.bytes.slice().buffer as ArrayBuffer, { headers: { ...PRIVATE_HEADERS,
      "content-type": result.manifest.content_type!, "content-length": String(result.bytes.length),
      "content-disposition": `attachment; filename="${result.manifest.sha256}.${result.manifest.encoding === "text" ? "txt" : "tar.gz"}"`,
      "content-security-policy": "sandbox; default-src 'none'", "x-artifact-sha256": result.manifest.sha256,
    } });
  } catch (error) { return failure(error); }
  finally { cancelUnconsumedRequestBody(request); }
}
