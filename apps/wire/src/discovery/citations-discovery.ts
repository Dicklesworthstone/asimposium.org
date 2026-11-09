/** Citation heads, exact versions and their literature aliases share one
 * immutable public cut across reading, pagination and bibliography exports. */
export const CITATIONS_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/citations.json":
    "Citation heads and source provenance at a fixed ledger snapshot (JSON).",
  "GET /p/:id/citations.md":
    "Citation heads, source provenance and bounded continuation (Markdown).",
  "GET /p/:id/citations.html": "Citation heads, source provenance and bounded continuation (HTML).",
  "GET /p/:id/literature.json":
    "Literature alias of the citation collection with the same snapshot and continuation (JSON).",
  "GET /p/:id/literature.md":
    "Literature alias of the citation collection with the same snapshot and continuation (Markdown).",
  "GET /p/:id/literature.html":
    "Literature alias of the citation collection with the same snapshot and continuation (HTML).",
  "GET /p/:id/citations/:target":
    "Exact citation head or L-n@version at an optional ledger snapshot; .json, .md, .html, .bib and .csl.json use the same verified source.",
});

function resource(path: string): "list" | "single" | undefined {
  if (/^\/p\/\{id\}\/(?:citations|literature)\.(?:json|md|html)$/.test(path)) return "list";
  return path === "/p/{id}/citations/{target}" ? "single" : undefined;
}

export function citationParameters(path: string, origin: string): readonly unknown[] {
  const kind = resource(path);
  if (kind === undefined) return [];
  const descriptions: Readonly<Record<string, string>> = {
    through:
      "Captured public problem cursor. Keep the same cut on every continuation, exact-version read and bibliography export. Later corrections are excluded; current visibility and content controls still apply.",
    after:
      "Exclusive source sequence from next_after. Requires the original through cursor and cannot exceed it. Withheld or nonmatching citation heads still advance; an empty page can have a continuation.",
    limit:
      "Maximum citation heads examined per page, from 1 to 200; defaults to 50. Complete source publications also share a bounded byte budget.",
    unanchored:
      "Use the literal string true or false to select citation heads with that recorded provenance status at the snapshot. Omit for both. Retain the filter on every continuation; a retrieved locator does not establish scientific verification.",
  };
  return (kind === "single" ? ["through"] : ["through", "after", "limit", "unanchored"]).map(
    (name) => ({
      name,
      in: "query",
      required: false,
      description: descriptions[name],
      schema: {
        $ref: `${origin}/schemas/citations.v1.json#/$defs/${kind === "single" ? "read_query" : "query"}/properties/${name}`,
      },
    }),
  );
}

export function citationResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = resource(path);
  if (kind === undefined) return undefined;
  const json = {
    schema: {
      $ref: `${origin}/schemas/citations.v1.json${kind === "single" ? "#/$defs/single" : ""}`,
    },
  };
  const content =
    kind === "single"
      ? {
          "application/json": json,
          "text/markdown": {},
          "text/html": {},
          "application/x-bibtex": {},
          "application/vnd.citationstyles.csl+json": {},
        }
      : path.endsWith(".json")
        ? { "application/json": json }
        : path.endsWith(".md")
          ? { "text/markdown": {} }
          : { "text/html": {} };
  const error = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        kind === "single"
          ? "The exact verified citation source, with bounded readable version history and associations for JSON/Markdown/HTML. Bibliography exports retain the same selected version and snapshot. Current content controls apply to every representation."
          : "Latest readable citation versions at one captured cursor, in source sequence order. Follow next_after or rel=next even when no matching citation is visible on a page; omitted explains bounded reads. The literature alias returns the same collection and canonical citation links.",
      content,
      headers: {
        ETag: { schema: { type: "string" } },
        "Content-Location": {
          description:
            "Canonical citation location retaining the exact version or page, selected snapshot, filter and representation.",
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
      description:
        "Public problem or exact citation unavailable, including private or currently withheld sources and invalid citation targets.",
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
