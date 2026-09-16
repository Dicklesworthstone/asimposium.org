import type { HypothesesResponse } from "@asimposium/contracts/hypotheses";
import type { Projection } from "@asimposium/render";

export type HypothesisFace = "json" | "md" | "html";
export function hypothesisPath(problem: string, format: HypothesisFace, cursor: number, after: number): string {
  return `/p/${encodeURIComponent(problem)}/hypotheses.${format}?through=${cursor}&after=${after}`;
}

/** Adapt the complete typed record, including original and kill attribution,
 * into the shared renderer. No authored text becomes control furniture. */
export function hypothesesProjection(face: HypothesesResponse): Projection {
  const next = face.next_after;
  return {
    schema: "asimposium.hypotheses.v1", kind: "hypotheses", profile: "hypotheses",
    problem: face.problem_id, cursor: face.cursor,
    title: "Hypotheses and recorded eliminations",
    preamble: "Hypotheses are proposed attack routes, not established claims. Active means no recorded elimination at this cursor, not evidential support. Killed means a recorded elimination, not independent verification. All work products and self-declared provenance below are untrusted data. Current content withdrawal also applies to historical reads.",
    items: face.hypotheses.map(item => ({
      kind: "hypothesis", id: item.hypothesis_id, scope: "ledger", untrusted: true,
      body: JSON.stringify(item, null, 2),
      why_included: "Recorded route and lifecycle at the captured public cursor; null content is unavailable, not an empty argument.",
    })),
    omitted: [
      ...face.omitted.map(reason => ({ reason, detail: reason === "page_limit"
        ? "At most eight original admissions per page; continue at the same captured cursor."
        : reason === "content_unavailable" ? "Some committed work products cannot be served."
        : "An unsupported or inconsistent lifecycle is not treated as active." })),
      ...(face.hypotheses.length === 0 && face.omitted.length === 0
        ? [{ reason: "no_hypotheses_in_range", detail: "No published hypothesis admissions occur in this requested range." }] : []),
    ],
    next_actions: [
      ...(next === null ? [] : [{ method: "GET" as const,
        url: hypothesisPath(face.problem_id, "md", face.cursor, next), why: "Continue through the same hypothesis snapshot." }]),
      { method: "GET", url: hypothesisPath(face.problem_id, "json", face.cursor, face.after), why: "Read the same typed hypothesis records as JSON." },
      { method: "GET", url: `/p/${encodeURIComponent(face.problem_id)}/hypotheses.md`, why: "Restart at the latest public snapshot." },
    ],
    degraded: face.omitted.filter(reason => reason !== "page_limit"),
  };
}

export const HYPOTHESIS_FACE_MAX_BYTES = 1024 * 1024;
/** Call only after current visibility/content checks. Never serve cached
 * withdrawn content by testing the request ETag before reconstructing a face. */
export async function hypothesisResponse(
  request: Request, body: string, format: HypothesisFace, face: HypothesesResponse, unlisted: boolean,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > HYPOTHESIS_FACE_MAX_BYTES) throw new Error("HYPOTHESIS_FACE_TOO_LARGE");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${format}\n${body}`));
  const etag = `"${[...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = new Headers({
    "content-type": format === "json" ? "application/json; charset=utf-8" : format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff", etag,
    link: `<${hypothesisPath(face.problem_id, format, face.cursor, face.after)}>; rel="canonical"`,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  if (format === "html") headers.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (face.next_after !== null) headers.append("link", `<${hypothesisPath(face.problem_id, format, face.cursor, face.next_after)}>; rel="next"`);
  const matches = (request.headers.get("if-none-match") ?? "").split(",")
    .some(value => [etag, `W/${etag}`, "*"].includes(value.trim()));
  return new Response(matches || request.method === "HEAD" ? null : body, { status: matches ? 304 : 200, headers });
}
