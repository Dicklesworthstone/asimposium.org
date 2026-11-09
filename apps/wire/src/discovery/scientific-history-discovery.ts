/** Mounted histories and exact immutable scientific work products. */
export const SCIENTIFIC_HISTORY_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/statements": "Redirect to canonical published statement history in Markdown.",
  "GET /p/:id/statements.json":
    "Complete published formulations at a fixed ledger snapshot (JSON).",
  "GET /p/:id/statements.md": "Complete published formulation history (Markdown).",
  "GET /p/:id/statements.html": "Complete published formulation history (HTML).",
  "GET /p/:id/statements/:reference":
    "One exact public statement version, with .json, .md or .html; private draft versions are unavailable.",
  "GET /p/:id/syntheses.json": "Bounded synthesis publications at a fixed ledger snapshot (JSON).",
  "GET /p/:id/syntheses.md": "Bounded synthesis publications and continuation (Markdown).",
  "GET /p/:id/syntheses.html": "Bounded synthesis publications and continuation (HTML).",
  "GET /p/:id/syntheses/:target": "Exact problem synthesis version (Markdown, JSON, or HTML face).",
});

function resource(path: string) {
  if (/^\/p\/\{id\}\/statements(?:\.(?:json|md|html))?$/.test(path)) return "statements";
  if (path === "/p/{id}/statements/{reference}") return "statement";
  if (/^\/p\/\{id\}\/syntheses\.(?:json|md|html)$/.test(path)) return "syntheses";
  if (path === "/p/{id}/syntheses/{target}") return "synthesis";
  return undefined;
}

export function scientificHistoryParameters(path: string, origin: string): readonly unknown[] {
  const kind = resource(path);
  if (kind === undefined || kind === "synthesis") return [];
  const schema =
    kind === "syntheses"
      ? "syntheses.v1.json#/$defs/query"
      : `statements.v1.json#/properties/${kind === "statements" ? "history_query" : "version_query"}`;
  const parameters =
    kind === "syntheses"
      ? ["through", "before", "limit"]
      : kind === "statements"
        ? ["through", "after"]
        : ["through"];
  const descriptions: Record<string, string> = {
    through:
      "Capture the first response's cursor and retain it through every continuation. Present-day content withdrawals still apply.",
    after:
      "Use next_after unchanged with the captured through cursor. Four immutable publications are examined per page; a wholly withheld page can still continue.",
    before:
      "Use next_before unchanged with the required captured through cursor. Publications descend by sequence; withheld sources still advance.",
    limit:
      "Maximum source publications examined per page, from 1 to 200; defaults to 8. Complete work products also share a bounded byte budget.",
  };
  return parameters.map((name) => ({
    name,
    in: "query",
    required: false,
    description: descriptions[name],
    schema: { $ref: `${origin}/schemas/${schema}/properties/${name}` },
  }));
}

export function scientificHistoryResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = resource(path);
  if (kind === undefined) return undefined;
  const errors = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  const schema =
    kind === "syntheses"
      ? "syntheses.v1.json"
      : kind === "synthesis"
        ? "syntheses.v1.json#/$defs/single"
        : `statements.v1.json#/properties/${kind === "statements" ? "history" : "response"}`;
  const json = { schema: { $ref: `${origin}/schemas/${schema}` } };
  const content = path.endsWith(".json")
    ? { "application/json": json }
    : path.endsWith(".md")
      ? { "text/markdown": {} }
      : path.endsWith(".html")
        ? { "text/html": {} }
        : { "application/json": json, "text/markdown": {}, "text/html": {} };
  return {
    ...(path.endsWith("/statements")
      ? {}
      : {
          "200": {
            description:
              "Verified immutable publication content at the requested cut. Current visibility overrides historical availability; unavailable content is never substituted from retained projections.",
            content,
            headers: { ETag: { schema: { type: "string" } }, Link: { schema: { type: "string" } } },
          },
          "304": {
            description:
              "Unchanged representation after rechecking current source availability. No response body.",
          },
        }),
    ...(kind === "statement" || path.endsWith("/statements")
      ? {
          "308": {
            description: "Canonical Markdown location retaining the exact version and query.",
            headers: { Location: { schema: { type: "string" } } },
          },
        }
      : {}),
    ...(kind === "synthesis"
      ? {}
      : {
          "400": {
            description: "Invalid, unsupported or repeated selector or cursor.",
            content: errors,
          },
        }),
    "404": {
      description:
        "Problem or exact public publication unavailable, including private and withdrawn sources.",
      content: errors,
    },
    default: {
      description:
        "Read unavailable; retry the unchanged request without advancing. Never an invented empty history.",
      content: errors,
    },
  };
}
