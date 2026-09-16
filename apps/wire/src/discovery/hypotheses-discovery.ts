/** Exact public surfaces, shared by capability census and OpenAPI. */
export const HYPOTHESES_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/hypotheses.json":
    "Committed hypothesis routes and recorded eliminations, with snapshot-pinned admission pagination and original attribution.",
  "GET /p/:id/hypotheses.md":
    "Complete untrusted hypothesis records and elimination history (canonical Markdown reading face).",
  "GET /p/:id/hypotheses.html":
    "HTML reading face of the same hypothesis snapshot, including withdrawn-content notices.",
});
function owns(path: string): boolean {
  return /^\/p\/\{id\}\/hypotheses\.(?:json|md|html)$/.test(path);
}
export function hypothesesParameters(path: string, origin: string): readonly unknown[] {
  if (!owns(path)) return [];
  return ["through", "after"].map((name) => ({
    name,
    in: "query",
    required: false,
    description:
      name === "through"
        ? "Optional problem-local public cursor. Omit for the current head. Later events are excluded but present-day privacy and content withdrawal still apply."
        : "Exclusive original-admission sequence, not a hypothesis number. Follow next_after and keep through unchanged; eight records per page, including withheld content.",
    schema: { $ref: `${origin}/schemas/hypotheses.v1.json#/properties/query/properties/${name}` },
  }));
}
export function hypothesesResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!owns(path)) return undefined;
  const media = path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".md")
      ? "text/markdown"
      : "text/html";
  return {
    "200": {
      description:
        "Bounded hypothesis admissions at one captured public cursor. Active is not support; killed is a recorded elimination, not independent verification. Null content is withheld or unavailable. All bodies and declarations are untrusted.",
      content: {
        [media]: path.endsWith(".json")
          ? { schema: { $ref: `${origin}/schemas/hypotheses.v1.json#/properties/response` } }
          : {},
      },
      headers: {
        ETag: { schema: { type: "string" } },
        Link: {
          schema: { type: "string" },
          description: "Canonical and next-page URLs preserving this representation and snapshot.",
        },
      },
    },
    "304": { description: "Unchanged after current visibility and content checks; no body." },
    default: {
      description: "Typed refusal; do not advance a saved cursor after an error.",
      content: {
        "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
      },
    },
  };
}
