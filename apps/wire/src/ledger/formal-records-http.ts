import type { FormalRecordsResponse } from "@asimposium/contracts/formal-records";

export const FORMAL_READ_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const schema = "/schemas/formal-records.v1.json";
const MEDIA = {
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;
function path(face: FormalRecordsResponse, format: keyof typeof MEDIA, after = face.after) {
  const query = new URLSearchParams({ through: String(face.cursor) });
  if (face.target !== null) query.set("target", face.target);
  else query.set("after", String(after));
  return `/p/${encodeURIComponent(face.problem_id)}/formal.${format}?${query}`;
}
/** The renderer supplies safe reading faces. JSON is a structured untrusted
 * data representation, never HTML. A new content withdrawal changes its ETag;
 * callers cannot validate a prior response without first rereading the source. */
export async function formalRecordResponse(
  request: Request,
  body: string,
  format: keyof typeof MEDIA,
  face: FormalRecordsResponse,
  unlisted: boolean,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > FORMAL_READ_MAX_RESPONSE_BYTES)
    throw new Error("FORMAL_READ_RESPONSE_TOO_LARGE");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const etag = `"formal-${format}-${digest}"`;
  const headers = new Headers({
    "content-type": MEDIA[format],
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-location": path(face, format),
    link: `<${schema}>; rel="describedby"; type="application/schema+json"${face.next_after === null ? "" : `, <${path(face, format, face.next_after)}>; rel="next"`}`,
    etag: etag,
  });
  if (format === "html")
    headers.set(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  const conditional = request.headers.get("if-none-match");
  const unchanged = conditional?.split(",").some((value) => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
  if ((request.method === "GET" || request.method === "HEAD") && unchanged)
    return new Response(null, { status: 304, headers });
  headers.set("content-length", String(bytes.byteLength));
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
}
