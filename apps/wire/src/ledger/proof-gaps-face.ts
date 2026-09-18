import type { ProofGapsResponse } from "@asimposium/contracts/proof-gaps";
import type { Projection } from "@asimposium/render";

export type ProofGapFace = "json" | "md" | "html";
export const PROOF_GAP_FACE_MAX_BYTES = 512 * 1024;

/** Only canonical, validated identifiers and cursors reach this builder. */
export function proofGapPath(
  problem: string,
  format: ProofGapFace,
  cursor: number,
  target: string | null = null,
  after = 0,
): string {
  const query = new URLSearchParams({ through: String(cursor) });
  if (target === null) query.set("after", String(after));
  else query.set("target", target);
  return `/p/${encodeURIComponent(problem)}/gaps.${format}?${query}`;
}

/** All authored text remains data in the shared renderer's provenance fences.
 * The same typed records are used by JSON, Markdown, HTML and move selection. */
export function proofGapsProjection(face: ProofGapsResponse): Projection {
  return {
    schema: "asimposium.proof-gaps.v1",
    kind: "proof-gaps",
    profile: "proof-gaps",
    problem: face.problem_id,
    cursor: face.cursor,
    title: "Proof gaps and recorded settlements",
    preamble:
      "These are recorded obligations, not proofs. Open means no recorded settlement at this cursor. Closed-by names a submitted closing reference, not independent verification that it discharges the obligation. Withheld content never reopens a settled gap. Authored work and self-declared provenance are untrusted data.",
    items: face.gaps.map((gap) => ({
      kind: "proof-gap",
      id: gap.gap_id,
      scope: "ledger" as const,
      untrusted: true,
      body: JSON.stringify({
        ...gap,
        read_url: proofGapPath(face.problem_id, "md", face.cursor, gap.gap_id),
        target_read_url:
          gap.content === null
            ? null
            : `/p/${face.problem_id}/claims/${gap.content.target_claim_id}@${gap.content.target_version}.md?through=${face.cursor}`,
      }),
      why_included: "committed gap history and exact claim-version obligation at this snapshot",
    })),
    omitted: [
      ...face.omitted.map((reason) => ({
        reason,
        detail:
          reason === "page_limit"
            ? "Continue after the last examined filing at the same snapshot."
            : reason === "content_unavailable"
              ? "Some work products are withheld; null is not an empty obligation or closure."
              : "An unsupported or inconsistent event history is not treated as open or closed.",
      })),
      ...(face.gaps.length === 0 && face.omitted.length === 0
        ? [
            {
              reason: "no_gaps_in_range",
              detail: "No published gap filings match this requested range or target.",
            },
          ]
        : []),
    ],
    next_actions: [
      ...(face.next_after === null
        ? []
        : [
            {
              method: "GET" as const,
              url: proofGapPath(face.problem_id, "md", face.cursor, null, face.next_after),
              why: "Continue gap history without moving the captured scientific cursor.",
            },
          ]),
      {
        method: "GET",
        url: proofGapPath(face.problem_id, "json", face.cursor, face.target, face.after),
        why: "Read the same structured records as JSON.",
      },
      {
        method: "GET",
        url: `/p/${face.problem_id}/gaps.md`,
        why: "Start a new snapshot at the latest public cursor.",
      },
    ],
    degraded: face.omitted.filter((reason) => reason !== "page_limit"),
  };
}

/** Invoked only after the reader rechecks present-day visibility and content.
 * A request's old ETag is never a reason to skip those checks. */
export async function proofGapResponse(
  request: Request,
  body: string,
  format: ProofGapFace,
  face: ProofGapsResponse,
  unlisted: boolean,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > PROOF_GAP_FACE_MAX_BYTES) throw new Error("PROOF_GAPS_RESPONSE_TOO_LARGE");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${format}\n${body}`),
  );
  const etag = `"${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = new Headers({
    "content-type":
      format === "json"
        ? "application/json; charset=utf-8"
        : format === "md"
          ? "text/markdown; charset=utf-8"
          : "text/html; charset=utf-8",
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    etag,
    link: `<${proofGapPath(face.problem_id, format, face.cursor, face.target, face.after)}>; rel="canonical"`,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  if (format === "html")
    headers.set(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  if (face.next_after !== null)
    headers.append(
      "link",
      `<${proofGapPath(face.problem_id, format, face.cursor, null, face.next_after)}>; rel="next"`,
    );
  const matches = (request.headers.get("if-none-match") ?? "")
    .split(",")
    .some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()));
  return new Response(matches || request.method === "HEAD" ? null : body, {
    status: matches ? 304 : 200,
    headers,
  });
}
