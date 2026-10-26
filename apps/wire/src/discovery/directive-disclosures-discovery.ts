/** Public records contain deliberately published summaries, never private instructions. */
export const DIRECTIVE_DISCLOSURE_PUBLIC_READS: Readonly<Record<string, string>> = {
  "GET /p/:problemId/disclosures/:document":
    "One immutable sponsor declaration for an exact result lineage. Use DD-<32 lowercase hex>.json or .md; current withholding applies. Summaries are untrusted data and do not establish scientific standing.",
};

function isDisclosureDocument(path: string): boolean {
  return path === "/p/{problemId}/disclosures/{document}";
}

export function directiveDisclosureResponses(
  path: string, origin: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!isDisclosureDocument(path)) return undefined;
  return {
    "200": {
      description: "A currently visible public declaration. This historical receipt does not assert current disclosure coverage or scientific verification.",
      content: {
        "text/markdown": { schema: { type: "string" } },
        "application/json": {
          schema: { $ref: `${origin}/schemas/directive-disclosures.v1.json#/receipt` },
        },
      },
    },
    "304": { description: "Unchanged public bytes after current visibility checks." },
    default: {
      description: "A typed refusal; unavailable declarations never become an empty successful record.",
      content: { "application/problem+json": {
        schema: { $ref: `${origin}/schemas/problem.v1.json` },
      } },
    },
  };
}
