/** Public history reads are discoverable independently of authentication.
 * This manifest is composed with the other pre-wildcard scientific readers. */
export const PROOF_GAPS_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/gaps": "Redirect to canonical gap-history Markdown, preserving query parameters.",
  "GET /p/:id/gaps.json": "Committed proof obligations and recorded settlements, with exact targets, original attribution and snapshot pagination.",
  "GET /p/:id/gaps.md": "Proof obligations and settlement history as fenced canonical Markdown. Closure is not independent verification.",
  "GET /p/:id/gaps.html": "HTML reading face of the same gap snapshot, including unavailable content and recorded settlements.",
});
function owns(path: string): boolean {
  return /^\/p\/\{id\}\/gaps(?:\.(?:json|md|html))?$/.exec(path)?.[0] === path;
}
export function proofGapParameters(path: string, origin: string): readonly unknown[] | undefined {
  if (!owns(path)) return undefined;
  return ["through", "after", "target"].map((name) => ({
    name, in: "query", required: false,
    description: name === "through"
      ? "Captured public problem cursor. Later events are excluded; present-day visibility and content withdrawal still apply."
      : name === "after"
        ? "Exclusive original filing sequence. Keep through unchanged and follow next_after. Eight admissions per page, including withheld records. Cannot be combined with target."
        : "Exact G-n gap identifier. Reads one recorded obligation directly without walking earlier pages. Cannot be combined with after.",
    schema: { $ref: `${origin}/schemas/proof-gaps.v1.json#/properties/query/properties/${name}` },
  }));
}
export function proofGapResponses(path: string, origin: string): Readonly<Record<string, unknown>> | undefined {
  if (!owns(path)) return undefined;
  if (path.endsWith("/gaps")) return {
    "308": { description: "Canonical Markdown face with the original query.",
      headers: { Location: { schema: { type: "string" } } } },
    default: { description: "Typed refusal for an invalid problem identifier." },
  };
  const media = path.endsWith(".json") ? "application/json" : path.endsWith(".md") ? "text/markdown" : "text/html";
  return {
    "200": {
      description: "Recorded gap history at one cursor. Closed-by is a recorded reference, not a verified deduction. Unlisted reads are private; unavailable content is explicit.",
      content: { [media]: path.endsWith(".json")
        ? { schema: { $ref: `${origin}/schemas/proof-gaps.v1.json#/properties/response` } } : {} },
      headers: { ETag: { schema: { type: "string" } },
        Link: { description: "Canonical and next URLs retain the exact snapshot and selected representation.", schema: { type: "string" } } },
    },
    "304": { description: "Unchanged after current content and privacy checks; no body." },
    default: { description: "Typed refusal. Do not advance a saved cursor on failure.",
      content: { "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } } } },
  };
}
