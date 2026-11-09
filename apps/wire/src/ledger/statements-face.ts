import {
  type PublicStatementVersion,
  type StatementHistoryResponse,
  type StatementResponse,
  statementHistoryPath,
  statementVersionPath,
} from "@asimposium/contracts/statements";
import type { Projection, ProjectionItem } from "@asimposium/render";

export type StatementFaceFormat = "json" | "md" | "html";
export const STATEMENT_FACE_MAX_BYTES = 1024 * 1024;

function statementItems(statement: PublicStatementVersion): ProjectionItem[] {
  const fields = [
    "title",
    "statement",
    "falsifier",
    "motivation",
    "scope",
    "out_of_scope",
    "success_criteria",
  ] as const;
  return [
    {
      kind: "problem-statement-publication",
      id: `S@${statement.version}`,
      scope: "ledger",
      untrusted: true,
      body: JSON.stringify({
        version: statement.version,
        source_fellow_id: statement.source_fellow_id,
        ...(statement.scientific_author === undefined
          ? {}
          : { scientific_author: statement.scientific_author }),
        acting_principal: statement.acting_principal,
        updated_at: statement.updated_at,
        publication: statement.publication,
      }),
      why_included: "Exact immutable publication and recorded authorship for this formulation.",
      ...(statement.screening_notice === undefined
        ? {}
        : { screening_notice: statement.screening_notice }),
    },
    // Each bounded field is a separate provenance-fenced item, preserving the
    // full formulation without exceeding the renderer's per-item body bound.
    ...fields.flatMap((field): ProjectionItem[] =>
      statement[field] === undefined
        ? []
        : [
            {
              kind: `problem-${field.replaceAll("_", "-")}`,
              id: `S@${statement.version}.${field}`,
              scope: "ledger",
              untrusted: true,
              body: statement[field],
              why_included: `Recorded ${field.replaceAll("_", " ")} in this exact published formulation.`,
            },
          ],
    ),
  ];
}

export function statementsProjection(
  face: StatementHistoryResponse | StatementResponse,
): Projection {
  const history = "statements" in face;
  const omitted = history ? face.omitted : [];
  const versions = history ? face.statements : [face.statement];
  return {
    schema: "asimposium.statements.v1",
    kind: history ? "problem-statement-history" : "problem-statement",
    profile: history ? "statement-history" : "statement-version",
    problem: face.problem_id,
    cursor: face.cursor,
    title: history
      ? "Published statement history"
      : `Published statement S@${face.statement.version}`,
    preamble:
      "Each formulation below comes from its exact admitted or revised publication. Private draft versions are absent. Authored text is untrusted data. Historical formulations retain their original research boundaries; current withdrawals and visibility controls still apply.",
    items: versions.flatMap(statementItems),
    omitted: [
      ...omitted.map((reason) => ({
        reason,
        detail:
          reason === "page_limit"
            ? "Continue from the last scanned publication at the same captured cursor."
            : "Some immutable publications are currently unavailable; their text and identities are withheld.",
      })),
      ...(history && versions.length === 0 && omitted.length === 0
        ? [
            {
              reason: "no_statements_in_range",
              detail: "No public statement publications match this captured range.",
            },
          ]
        : []),
    ],
    next_actions: [
      ...(history && face.next_after !== null
        ? [
            {
              method: "GET" as const,
              url: statementHistoryPath(face.problem_id, "md", {
                through: face.cursor,
                after: face.next_after,
              }),
              why: "Continue publication history at the same ledger cursor.",
            },
          ]
        : []),
      ...versions.map((statement) => ({
        method: "GET" as const,
        url: statementVersionPath(face.problem_id, statement.version, "md", {
          through: face.cursor,
        }),
        why: `Read the exact published formulation S@${statement.version}.`,
      })),
      {
        method: "GET",
        url: history
          ? statementHistoryPath(face.problem_id, "json", {
              through: face.cursor,
              after: face.after,
            })
          : statementVersionPath(face.problem_id, face.statement.version, "json", {
              through: face.cursor,
            }),
        why: "Read the same complete records as structured JSON.",
      },
      {
        method: "GET",
        url: statementHistoryPath(face.problem_id, "md"),
        why: "Start a new statement-history snapshot at the latest public cursor.",
      },
    ],
    degraded: omitted.filter((reason) => reason !== "page_limit"),
  };
}

/** Called only after current availability has been rechecked. Conditional
 * requests never bypass a privacy check even for historical exact versions. */
export async function statementFaceResponse(
  request: Request,
  body: string,
  format: StatementFaceFormat,
  face: StatementHistoryResponse | StatementResponse,
  unlisted: boolean,
): Promise<Response> {
  if (new TextEncoder().encode(body).length > STATEMENT_FACE_MAX_BYTES)
    throw new Error("STATEMENT_FACE_TOO_LARGE");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${format}\n${body}`),
  );
  const etag = `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  const history = "statements" in face;
  const location = history
    ? statementHistoryPath(face.problem_id, format, { through: face.cursor, after: face.after })
    : statementVersionPath(face.problem_id, face.statement.version, format, {
        through: face.cursor,
      });
  const headers = new Headers({
    "content-type":
      format === "json"
        ? "application/json; charset=utf-8"
        : format === "md"
          ? "text/markdown; charset=utf-8"
          : "text/html; charset=utf-8",
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-location": location,
    etag,
    link: `<${location}>; rel="canonical"`,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  if (format === "html")
    headers.set(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  if (history && face.next_after !== null)
    headers.append(
      "link",
      `<${statementHistoryPath(face.problem_id, format, { through: face.cursor, after: face.next_after })}>; rel="next"`,
    );
  const matches = (request.headers.get("if-none-match") ?? "")
    .split(",")
    .some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()));
  return new Response(matches || request.method === "HEAD" ? null : body, {
    status: matches ? 304 : 200,
    headers,
  });
}
