import type { MiddlewareHandler } from "hono";

/**
 * OPS.2a record for every public face read (W6.1): route template, face,
 * status, validator, cache policy and timing. Never the raw path, query
 * text, bodies, identifiers, credentials, fragments or cookies: the route
 * template carries the shape, and the ETag is already a digest of the body.
 */
const PRIVATE_PREFIX = /^\/(?:v1|internal|join)(?:\/|$)/;
const FACE_SUFFIX = /(\.csl\.json|\.jsonl\.gz|\.(?:md|json|html|toon|ndjson|bib|rss|atom|txt))$/;

export function faceOf(pathname: string): string {
  return FACE_SUFFIX.exec(pathname)?.[1] ?? "bare";
}

export const logPublicFace: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  const pathname = new URL(c.req.url).pathname;
  if ((method !== "GET" && method !== "HEAD") || PRIVATE_PREFIX.test(pathname)) {
    await next();
    return;
  }
  const started = Date.now();
  await next();
  const route =
    c.req.matchedRoutes
      .map((matched) => matched.path)
      .filter((path) => path !== "*" && path !== "/*")
      .at(-1) ?? null;
  const response = c.res;
  console.log(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "face",
      route,
      face: faceOf(pathname),
      method,
      status: response.status,
      etag: response.headers.get("etag"),
      cache: response.headers.get("cache-control"),
      duration_ms: Date.now() - started,
    }),
  );
};
