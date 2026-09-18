import type { FellowCredentialBinding } from "../enrollment/service.ts";
import type { ValidatedProblemInput } from "../http/envelope.ts";
import type { PublicationRequest } from "./artifact-publication-store.ts";

export const PUBLICATION_BODY_BYTES = 4096;
export const PUBLICATION_BODY_TIMEOUT_MS = 10_000;
export const PUBLICATION_HTTP_SCHEMA = "https://a.asimposium.org/schemas/artifact-publications.v1.json";
const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" };
const PUBLIC = { "cache-control": "no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff" };
const PROBLEM = "(P-[A-Z0-9][A-Z0-9-]{1,30})";
const EXAMPLE = { method: "POST", path: `/v1/artifacts/AU-${"0".repeat(32)}/publish`,
  headers: { "Content-Type": "application/json", "Idempotency-Key": "publish-artifact-1" },
  body: { session_id: `S-${"A".repeat(26)}`, evidence_id: "E-1",
    evidence_digest: `sha256:${"0".repeat(64)}`, publish: true, license: "CC-BY-4.0" } };

type PublicationRoute =
  | { kind: "publish"; id: string }
  | { kind: "status"; id: string }
  | { kind: "manifest"; problem: string; id: string }
  | { kind: "evidence"; problem: string; evidence: string };

/** Exact, closed namespace. A neighboring route never constructs publication
 * dependencies; encoded slashes, URL-supplied principals and arbitrary R2 keys
 * are not accepted aliases. */
export function artifactPublicationRoute(path: string): PublicationRoute | undefined {
  let match = /^\/v1\/artifacts\/(AU-[a-f0-9]{32})\/publish$/.exec(path);
  if (match?.[1]) return { kind: "publish", id: match[1] };
  match = /^\/v1\/artifact-publications\/(AP-[a-f0-9]{32})$/.exec(path);
  if (match?.[1]) return { kind: "status", id: match[1] };
  match = new RegExp(`^/p/${PROBLEM}/artifacts/(AP-[a-f0-9]{32})\\.json$`).exec(path);
  if (match?.[1] && match[2] && !match[1].includes("--"))
    return { kind: "manifest", problem: match[1], id: match[2] };
  match = new RegExp(`^/p/${PROBLEM}/evidence/(E-[A-Za-z0-9]{1,78})/artifacts\\.json$`).exec(path);
  if (match?.[1] && match[2] && !match[1].includes("--"))
    return { kind: "evidence", problem: match[1], evidence: match[2] };
  return undefined;
}

export class PublicationHttpError extends Error {
  constructor(readonly code: "AUTH" | "DENIED" | "NOT_FOUND" | "CONFLICT" | "BUSY" | "THROTTLED" | "UNAVAILABLE",
    readonly retryAfterSeconds?: number) { super(`PUBLICATION_HTTP_${code}`); }
}

/** Composition supplies the real Zod decoder, canonical problem renderer,
 * fresh enrollment authority and durable services. No transport port can be
 * selected through request data. Operation results are schema-validated at
 * that composition boundary before they reach serialization here. */
export interface PublicationHttpOperations {
  readonly authenticate: (token: string) => Promise<FellowCredentialBinding | undefined>;
  readonly decodeRequest: (value: unknown) => PublicationRequest | undefined;
  readonly problem: (input: ValidatedProblemInput) => Response;
  readonly publish: (actor: FellowCredentialBinding, upload: string, input: PublicationRequest, key: string) => Promise<{ readonly status_path: string }>;
  readonly status: (actor: FellowCredentialBinding, id: string) => Promise<unknown>;
  readonly manifest: (problem: string, id: string) => Promise<unknown>;
  readonly evidence: (problem: string, evidence: string, after: number, through?: number) => Promise<unknown>;
}

function cancel(request: Request): void {
  try { if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined); }
  catch { /* A refusal must never wait for an upstream body producer. */ }
}

/** Fixed allocation, fatal UTF-8, exact declared length, bounded elapsed time.
 * Cancellation is best effort and is never awaited on the response path. */
export async function readPublicationRequestBody(request: Request, timeoutMs = PUBLICATION_BODY_TIMEOUT_MS): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PUBLICATION_BODY_TIMEOUT_MS)
    throw new Error("PUBLICATION_BODY_TIMEOUT_INVALID");
  const length = request.headers.get("content-length"), encoding = request.headers.get("content-encoding");
  if (request.signal.aborted || (encoding !== null && encoding !== "identity") ||
    (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > PUBLICATION_BODY_BYTES))) {
    cancel(request); throw new Error("PUBLICATION_BODY_INVALID");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("PUBLICATION_BODY_REQUIRED");
  const stop = () => { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let interrupted = false;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => { interrupted = true; reject(new Error("PUBLICATION_BODY_INTERRUPTED")); stop(); };
    timer = setTimeout(onAbort, timeoutMs);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  });
  try {
    const bytes = new Uint8Array(PUBLICATION_BODY_BYTES);
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (interrupted) throw new Error("PUBLICATION_BODY_INTERRUPTED");
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.length > bytes.length - size)
        throw new Error("PUBLICATION_BODY_TOO_LARGE");
      bytes.set(next.value, size); size += next.value.length;
    }
    if (length !== null && size !== Number(length)) throw new Error("PUBLICATION_BODY_LENGTH_INVALID");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) { stop(); throw error; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* Do not replace a bounded refusal. */ }
  }
}

function teaching(ops: PublicationHttpOperations, status: number, detail: string, headers: Record<string, string> = {}) {
  return ops.problem({ status, code: "SCHEMA_INVALID", title: "Artifact publication request needs correction", detail,
    fixHint: "Follow the publication schema. Publication is a separate, explicit CC-BY action; upload verification alone does not publish.",
    rule: "A5", extensions: { schema: PUBLICATION_HTTP_SCHEMA, example: EXAMPLE }, headers: { ...PRIVATE, ...headers } });
}
function failure(ops: PublicationHttpOperations, error: unknown): Response {
  const code = error instanceof PublicationHttpError ? error.code : "UNAVAILABLE";
  const retry = error instanceof PublicationHttpError && Number.isSafeInteger(error.retryAfterSeconds) &&
    error.retryAfterSeconds! > 0 ? String(Math.min(error.retryAfterSeconds!, 86400)) : "30";
  if (code === "CONFLICT" || code === "BUSY") return teaching(ops, 409,
    code === "BUSY" ? "An attempt is still in progress. Retry the same request and Idempotency-Key."
      : "The request conflicts with an existing publication or cursor. Recover the original receipt before starting another operation.",
    code === "BUSY" ? { "retry-after": retry } : {});
  const status = code === "AUTH" ? 401 : code === "DENIED" ? 403 : code === "NOT_FOUND" ? 404 : code === "THROTTLED" ? 429 : 503;
  return ops.problem({ status, code: status === 401 ? "UNAUTHORIZED" : status === 404 ? "ROUTE_NOT_FOUND"
      : status === 403 || status === 429 ? "WRITE_REFUSED" : "INTERNAL_ERROR",
    title: "Artifact publication unavailable", detail: "This publication operation could not be completed safely.",
    fixHint: status === 503 || status === 429 ? "Retry the same operation later. Consult the operator if this persists."
      : "Use a valid Fellow credential for private operations, or a currently available public publication identifier.",
    headers: { ...PRIVATE, ...(status === 503 || status === 429 ? { "retry-after": retry } : {}) } });
}
async function publicJson(request: Request, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const etag = `"${Array.from(digest, x => x.toString(16).padStart(2, "0")).join("")}"`;
  const headers = { ...PUBLIC, "content-type": "application/json; charset=utf-8", etag };
  // Validation/read happens FIRST. An old ETag cannot resurrect redacted data.
  const conditional = request.headers.get("if-none-match");
  const matches = conditional?.split(",").some(value => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
  return new Response(matches || request.method === "HEAD" ? null : body, { status: matches ? 304 : 200, headers });
}
function cursor(query: URLSearchParams, name: string): number | undefined {
  const values = query.getAll(name);
  if (!values.length) return undefined;
  if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]!) || !Number.isSafeInteger(Number(values[0])))
    throw new Error("PUBLICATION_CURSOR_INVALID");
  return Number(values[0]);
}

export async function handleArtifactPublicationHttp(
  request: Request, ops: PublicationHttpOperations,
): Promise<Response | undefined> {
  const url = new URL(request.url), route = artifactPublicationRoute(url.pathname);
  if (!route) return undefined;
  let response: Response;
  try {
    const isPublic = route.kind === "manifest" || route.kind === "evidence";
    const allowed = route.kind === "publish" ? "POST" : isPublic ? "GET, HEAD" : "GET";
    if (!(request.method === "POST" && route.kind === "publish") &&
      !(request.method === "GET" && route.kind !== "publish") && !(request.method === "HEAD" && isPublic))
      response = teaching(ops, 405, `This operation requires ${allowed}.`, { allow: allowed });
    else if (route.kind !== "evidence" && url.search !== "")
      response = teaching(ops, 400, "This publication operation accepts no query parameters. Credentials belong only in Authorization.");
    else if (route.kind === "manifest") response = await publicJson(request, await ops.manifest(route.problem, route.id));
    else if (route.kind === "evidence") {
      let after: number, through: number | undefined;
      try {
        if ([...url.searchParams.keys()].some(key => key !== "after" && key !== "through")) throw new Error("UNKNOWN_QUERY");
        after = cursor(url.searchParams, "after") ?? 0; through = cursor(url.searchParams, "through");
        if (through !== undefined && through < after) throw new Error("REVERSED_RANGE");
      } catch {
        const refused = teaching(ops, 400, "Use unique, nonnegative safe-integer after and through cursors, with through at least after.");
        return request.method === "HEAD" ? new Response(null, { status: refused.status, headers: refused.headers }) : refused;
      }
      response = await publicJson(request, await ops.evidence(route.problem, route.evidence, after, through));
    } else {
      if (request.headers.has("asimp-service-envelope")) throw new PublicationHttpError("AUTH");
      const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer || bearer.length > 256) throw new PublicationHttpError("AUTH");
      const actor = await ops.authenticate(bearer);
      if (!actor || actor.credentialProfile !== "bearer") throw new PublicationHttpError("AUTH");
      if (route.kind === "status") response = new Response(JSON.stringify(await ops.status(actor, route.id)), {
        headers: { ...PRIVATE, "content-type": "application/json; charset=utf-8" } });
      else {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? ""))
          return teaching(ops, 415, "Send the publication consent as application/json; do not send file bytes to this endpoint.");
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key))
          return teaching(ops, 400, "Supply a stable Idempotency-Key of 1–128 safe identifier characters.");
        let input: PublicationRequest | undefined;
        try { input = ops.decodeRequest(await readPublicationRequestBody(request)); }
        catch { return teaching(ops, 400, "Send complete UTF-8 JSON within the 4 KiB limit and request deadline."); }
        if (!input) return teaching(ops, 422, "Specify an owned session, exact evidence digest, publish: true and license: CC-BY-4.0. No other fields are accepted.");
        const receipt = await ops.publish(actor, route.id, input, key);
        response = new Response(JSON.stringify(receipt), { status: 202,
          headers: { ...PRIVATE, "content-type": "application/json; charset=utf-8", location: receipt.status_path, "retry-after": "30" } });
      }
    }
  } catch (error) { response = failure(ops, error); }
  finally { cancel(request); }
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
