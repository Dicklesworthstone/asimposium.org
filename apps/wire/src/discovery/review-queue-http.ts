export const REVIEW_QUEUE_MAX_RESPONSE_BYTES = 1024 * 1024;
export const REVIEW_QUEUE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
export type ReviewQueueFormat = "json" | "md" | "html";
const MEDIA = {
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

/** Revalidation happens only AFTER the reader has rechecked current visibility.
 * Public records are not served stale from a shared cache. Failures never get a public ETag. */
export async function reviewQueueResponse(
  request: Request,
  body: string,
  format: ReviewQueueFormat,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > REVIEW_QUEUE_MAX_RESPONSE_BYTES)
    throw new Error("REVIEW_QUEUE_RESPONSE_TOO_LARGE");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${format}\n${body}`),
  );
  const etag = `"${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = {
    "content-type": MEDIA[format],
    "cache-control": REVIEW_QUEUE_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    vary: "Accept, Accept-Encoding",
    etag,
  };
  const matches = (request.headers.get("if-none-match") ?? "")
    .split(",")
    .some((value) => value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === "*");
  return matches
    ? new Response(null, { status: 304, headers })
    : new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
