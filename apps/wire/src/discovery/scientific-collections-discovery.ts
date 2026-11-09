/** Both public collections expose one fixed-cut selection contract for JSON,
 * Markdown and HTML. Parameters refer to the served Zod-generated schemas. */
function collection(path: string): "conflicts" | "questions" | undefined {
  const match = /^\/p\/\{id\}\/(conflicts|questions)\.(?:json|md|html)$/.exec(path);
  return match?.[0] === path ? (match[1] as "conflicts" | "questions") : undefined;
}

export function scientificCollectionParameters(path: string, origin: string): readonly unknown[] {
  const kind = collection(path);
  if (kind === undefined) return [];
  const descriptions = {
    through:
      "Captured public problem cursor. Retain the first response's cursor on every continuation; later lifecycle changes are excluded, while current visibility and content withdrawals still apply.",
    after:
      "Exclusive publication sequence from next_after. Requires the original through cursor and cannot exceed it. Withheld records and nonmatching statuses still advance; an empty page can have a continuation. Cannot be combined with target.",
    limit:
      "Maximum publication positions examined per page, from 1 to 200; defaults to 50. Complete records also share a bounded response budget. Exact targets select one record directly.",
    status:
      "Filter the recorded lifecycle state at the selected snapshot, after bounding publication positions. Keep the filter on every continuation. Cannot be combined with target. This status does not establish scientific correctness or current work availability.",
    target: `One exact ${kind === "conflicts" ? "CF-" : "Q-"} identifier, including records beyond the first collection page. Accepts an optional through cursor and limit; cannot be combined with after or status. Missing or currently withheld exact sources return 404.`,
  };
  return (["through", "after", "limit", "status", "target"] as const).map((name) => ({
    name,
    in: "query",
    required: false,
    description: descriptions[name],
    schema: { $ref: `${origin}/schemas/${kind}.v1.json#/$defs/query/properties/${name}` },
  }));
}

export function scientificCollectionResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = collection(path);
  if (kind === undefined) return undefined;
  const media = path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".md")
      ? "text/markdown"
      : "text/html";
  const error = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        "Immutable scientific publications and recorded lifecycle at one public cursor, in publication order. Current content controls apply. Follow next_after or rel=next even when the page contains no readable matching records; omitted explains limits. An exact target returns only that record.",
      content: {
        [media]: path.endsWith(".json")
          ? { schema: { $ref: `${origin}/schemas/${kind}.v1.json` } }
          : {},
      },
      headers: {
        ETag: { schema: { type: "string" } },
        "Content-Location": {
          description:
            "Canonical location retaining the selected snapshot, filters and representation.",
          schema: { type: "string" },
        },
        Link: {
          description:
            "Schema, canonical and optional next-page URLs. Follow the continuation unchanged.",
          schema: { type: "string" },
        },
      },
    },
    "304": {
      description:
        "Unchanged only after rechecking current privacy, content controls and source integrity; no body.",
    },
    "400": {
      description:
        "CURSOR_INVALID: unsupported, repeated or noncanonical query, incompatible selectors, or a future cursor.",
      content: error,
    },
    "404": {
      description:
        "Public problem or exact target unavailable, including private or currently withheld sources.",
      content: error,
    },
    "503": {
      description:
        "The source or lifecycle cannot be verified. Retry the same request without advancing; this is not an empty collection.",
      content: error,
      headers: { "Retry-After": { schema: { type: "string" } } },
    },
  };
}
