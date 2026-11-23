import type { MiddlewareHandler } from "hono";
import { containsCredentialShape } from "../../../../packages/contracts/src/diagnostic-safety.ts";
import { prepareRedactedSinkEvent } from "../observability/telemetry.ts";

/**
 * OPS.2a record for every public face read (W6.1 / OPS.4): route template, face,
 * status, validator, cache policy, correlation request_id, and timing. Routes
 * through the canonical OPS.4 pre-egress redactor (`prepareRedactedSinkEvent`) so
 * raw paths, query text, bodies, actor identifiers, credentials, fragments, or
 * cookies can never cross the log boundary.
 */
const PRIVATE_PREFIX = /^\/(?:v1|internal|join)(?:\/|$)/;
const FACE_SUFFIX = /(\.csl\.json|\.jsonl\.gz|\.(?:md|json|html|toon|ndjson|bib|rss|atom|txt))$/;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{4,64}$/;

export function faceOf(pathname: string): string {
  return FACE_SUFFIX.exec(pathname)?.[1] ?? "bare";
}

function safeCorrelationRequestId(rawHeader: string | undefined): string {
  const candidate = rawHeader?.trim() ?? "";
  if (
    SAFE_REQUEST_ID_RE.test(candidate) &&
    !containsCredentialShape(candidate) &&
    !/^(?:asimp_|v1\.|flow_v1\.|F-|usr_)/i.test(candidate)
  ) {
    return candidate;
  }
  return crypto.randomUUID();
}

export const logPublicFace: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  const pathname = new URL(c.req.url).pathname;
  if ((method !== "GET" && method !== "HEAD") || PRIVATE_PREFIX.test(pathname)) {
    await next();
    return;
  }
  const started = Date.now();
  const requestId = safeCorrelationRequestId(
    c.req.header("x-request-id") ?? c.req.header("cf-ray"),
  );
  await next();
  const route =
    c.req.matchedRoutes
      .map((matched) => matched.path)
      .filter((path) => path !== "*" && path !== "/*")
      .at(-1) ?? null;
  const response = c.res;
  const { payload } = prepareRedactedSinkEvent("ops2a", {
    facility: "OPS.2a",
    stage: "face",
    request_id: requestId,
    route,
    face: faceOf(pathname),
    method,
    status: response.status,
    etag: response.headers.get("etag"),
    cache: response.headers.get("cache-control"),
    duration_ms: Math.max(0, Date.now() - started),
  });
  console.log(JSON.stringify(payload));
};
