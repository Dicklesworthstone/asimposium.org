/** Complete evidence and completed-review directories share a frozen problem cursor. */
export const RESEARCH_LIST_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/evidence":
    "Redirect to the canonical evidence directory, preserving its snapshot and continuation.",
  "GET /p/:id/evidence.json":
    "Public evidence publications, exact targets and immutable attribution at one snapshot (JSON).",
  "GET /p/:id/evidence.md": "Public evidence publications with bounded continuation (Markdown).",
  "GET /p/:id/evidence.html": "Public evidence publications with bounded continuation (HTML).",
  "GET /p/:id/reviews":
    "Redirect to the canonical completed-review directory, preserving its snapshot and continuation.",
  "GET /p/:id/reviews.json":
    "Completed public reviews with exact claim versions and publication-time independence (JSON).",
  "GET /p/:id/reviews.md": "Completed public reviews with bounded continuation (Markdown).",
  "GET /p/:id/reviews.html": "Completed public reviews with bounded continuation (HTML).",
});

function resource(path: string): "evidence" | "reviews" | undefined {
  const match = /^\/p\/\{id\}\/(evidence|reviews)(?:\.(?:json|md|html))?$/.exec(path);
  return match?.[1] as "evidence" | "reviews" | undefined;
}

export function researchListParameters(path: string, origin: string): readonly unknown[] {
  if (resource(path) === undefined) return [];
  const descriptions: Readonly<Record<string, string>> = {
    through:
      "Captured public problem cursor. Keep the same snapshot on every continuation. Later publications are excluded; current visibility and content controls still apply.",
    after:
      "Exclusive publication sequence from next_after. Requires the original through cursor and cannot exceed it. At most eight admissions are examined per page. Withheld publications still advance; an empty page can have a continuation.",
  };
  return ["through", "after"].map((name) => ({
    name,
    in: "query",
    required: false,
    description: descriptions[name],
    schema: {
      $ref: `${origin}/schemas/research-lists.v1.json#/properties/query/properties/${name}`,
    },
  }));
}

export function researchListResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = resource(path);
  if (kind === undefined) return undefined;
  if (!/\.(?:json|md|html)$/.test(path)) {
    return {
      "308": {
        description:
          "Permanent redirect to the canonical Markdown directory. The query string is preserved.",
        headers: { Location: { schema: { type: "string" } } },
      },
    };
  }
  const content = path.endsWith(".json")
    ? {
        "application/json": {
          schema: { $ref: `${origin}/schemas/research-lists.v1.json#/properties/${kind}` },
        },
      }
    : path.endsWith(".md")
      ? { "text/markdown": {} }
      : { "text/html": {} };
  const error = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        "At most eight verified public publications in sequence order at one frozen cursor. Original attribution, exact targets and authored direction or verdict are preserved; these are not computed scientific standing. Follow next_after or rel=next even on an empty page; omitted explains withheld sources and bounded reads.",
      content,
      headers: {
        ETag: { schema: { type: "string" } },
        "Content-Location": {
          description: "Canonical directory page retaining the captured cursor and continuation.",
          schema: { type: "string" },
        },
        Link: {
          description:
            "Schema, canonical and optional next-page URLs. Follow continuations unchanged.",
          schema: { type: "string" },
        },
      },
    },
    "304": {
      description:
        "Unchanged only after rechecking current visibility, content controls and immutable source integrity; no body.",
    },
    "400": {
      description:
        "CURSOR_INVALID: unsupported, repeated, noncanonical or incompatible query parameters, or a future cursor.",
      content: error,
    },
    "404": {
      description: "Public problem unavailable, including private or currently withheld problems.",
      content: error,
    },
    "503": {
      description:
        "The requested immutable source or bounded history could not be verified. Retry the same request without advancing; this is not an empty collection.",
      content: error,
      headers: { "Retry-After": { schema: { type: "string" } } },
    },
  };
}
