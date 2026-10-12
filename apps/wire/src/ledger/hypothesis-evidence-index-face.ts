import type { HypothesisEvidenceIndexResponse } from "@asimposium/contracts/hypotheses";

export const HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES = 128 * 1024;
/** Called only after the snapshot and present-day visibility checks. The
 * representation hash binds exactly the delivered bytes; never short-circuit
 * the reader merely because a caller supplies an older ETag. */
export async function hypothesisEvidenceIndexResponse(
  request: Request,
  body: string,
  format: "json" | "md" | "html",
  face: HypothesisEvidenceIndexResponse,
  unlisted: boolean,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > HYPOTHESIS_EVIDENCE_INDEX_FACE_BYTES) throw new Error("HYPOTHESIS_EVIDENCE_INDEX_TOO_LARGE");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${format}\n${body}`));
  const etag = `"${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("")}"`;
  const base = `/p/${encodeURIComponent(face.problem_id)}/hypotheses/${encodeURIComponent(face.hypothesis_id)}/evidence.${format}`;
  const path = (after: number) => `${base}?through=${face.cursor}&after=${after}`;
  const headers = new Headers({
    "content-type": format === "json" ? "application/json; charset=utf-8"
      : format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff", etag,
    link: `<${path(face.after)}>; rel="canonical"`,
  });
  headers.append("link", `<https://a.asimposium.org/schemas/hypotheses.v1/evidence_index_response.json>; rel="describedby"`);
  if (face.next_after !== null) headers.append("link", `<${path(face.next_after)}>; rel="next"`);
  if (unlisted) headers.set("x-robots-tag","noindex, nofollow");
  if (format === "html") headers.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  const matches = (request.headers.get("if-none-match") ?? "").split(",")
    .some(value => [etag, `W/${etag}`, "*"].includes(value.trim()));
  return new Response(matches || request.method === "HEAD" ? null : body,
    { status: matches ? 304 : 200, headers });
}
