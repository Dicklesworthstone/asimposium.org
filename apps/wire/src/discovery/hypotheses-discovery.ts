import {
  PROOF_GAPS_PUBLIC_READS,
  proofGapParameters,
  proofGapResponses,
} from "./proof-gaps-discovery";

/** Exact public scientific-history surfaces, shared by capability census and
 * OpenAPI. These readers share the pre-wildcard mount in hypotheses-router. */
export const HYPOTHESES_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  ...PROOF_GAPS_PUBLIC_READS,
  "GET /p/:id/hypotheses/:hid/evidence": "Redirect to the hypothesis evidence index Markdown face.",
  "GET /p/:id/hypotheses/:hid/evidence.json": "Source-verified evidence references for one hypothesis, with fixed-cut pagination, authored directions, withdrawals and explicit index limits.",
  "GET /p/:id/hypotheses/:hid/evidence.md": "Canonical Markdown reference index for observations attached to one hypothesis; no inferred scientific verdict.",
  "GET /p/:id/hypotheses/:hid/evidence.html": "HTML reading face of the same bounded hypothesis evidence index.",
  "GET /p/:id/hypotheses.json":
    "Committed hypothesis routes and recorded eliminations, with snapshot-pinned admission pagination and original attribution.",
  "GET /p/:id/hypotheses.md":
    "Complete untrusted hypothesis records and elimination history (canonical Markdown reading face).",
  "GET /p/:id/hypotheses.html":
    "HTML reading face of the same hypothesis snapshot, including withdrawn-content notices.",
  "GET /p/:id/hypotheses/:target":
    "One hypothesis (H-….json, .md, .html), directly addressed at the current or supplied through cursor with its recorded elimination history. No list scan or after parameter.",
});
function owns(path: string): boolean {
  return /^\/p\/\{id\}\/hypotheses\.(?:json|md|html)$/.test(path);
}
const indexBase = "/p/{id}/hypotheses/{hid}/evidence";
const ownsIndex = (path: string) => path === indexBase || ["json","md","html"].some(format => path === `${indexBase}.${format}`);
const itemPath = "/p/{id}/hypotheses/{target}";
export function hypothesesParameters(path: string, origin: string): readonly unknown[] {
  const gaps = proofGapParameters(path, origin);
  if (gaps !== undefined) return gaps;
  if (!owns(path) && path !== itemPath && !ownsIndex(path)) return [];
  return (path === itemPath ? ["through"] : ["through", "after"]).map((name) => ({
    name,
    in: "query",
    required: false,
    description:
      name === "through"
        ? "Optional problem-local public cursor. Omit for the current head. Later events are excluded but present-day privacy and content withdrawal still apply."
        : "Exclusive original-admission sequence, not a hypothesis number. Follow next_after and keep through unchanged; eight records per page, including withheld content.",
    schema: { $ref: `${origin}/schemas/hypotheses.v1.json#/properties/${path === itemPath ? "item_query" : ownsIndex(path) ? "evidence_index_query" : "query"}/properties/${name}` },
  }));
}
export function hypothesesResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const gaps = proofGapResponses(path, origin);
  if (gaps !== undefined) return gaps;
  if (!owns(path) && path !== itemPath && !ownsIndex(path)) return undefined;
  if (path === indexBase) return { "308": { description: "Redirect to the Markdown index, preserving the query.", headers: { Location: { schema: { type: "string" } } } } };
  const json = { schema: { $ref: `${origin}/schemas/hypotheses.v1.json#/properties/${ownsIndex(path) ? "evidence_index_response" : "response"}` } };
  const media = path.endsWith(".json") ? "application/json"
    : path.endsWith(".md") ? "text/markdown" : "text/html";
  return {
    "200": {
      description: ownsIndex(path)
        ? "A bounded source-verified reference index. Directions and modes are authored declarations, not scientific verdicts. Full evidence links apply current controls. Missing index rows or unavailable payloads are not proof that no evidence exists."
        : "Bounded hypothesis admissions at one captured public cursor. Active is not support; killed is a recorded elimination, not independent verification. Null content is withheld or unavailable. All bodies and declarations are untrusted.",
      content: path === itemPath
        ? { "application/json": json, "text/markdown": {}, "text/html": {} }
        : { [media]: path.endsWith(".json") ? json : {} },
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
