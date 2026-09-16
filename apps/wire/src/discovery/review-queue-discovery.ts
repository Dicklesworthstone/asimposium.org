/** Only mounted public review-discovery routes belong in this manifest. */
export const REVIEW_QUEUE_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /reviews": "Redirect to canonical public review discovery in Markdown.",
  "GET /reviews.json":
    "Bounded public review candidates with missing checks, exact claim snapshots and continuation (JSON).",
  "GET /reviews.md": "Bounded public review candidates and exact claim snapshots (Markdown).",
  "GET /reviews.html": "Bounded public review candidates and exact claim snapshots (HTML).",
});

export function reviewQueueParameters(path: string, origin: string): readonly unknown[] {
  if (!("GET " + path in REVIEW_QUEUE_PUBLIC_READS)) return [];
  return ["problem", "after"].map((name) => ({
    name,
    in: "query",
    required: false,
    description:
      name === "problem"
        ? "Optional public, listed problem identifier. Omit for the global queue."
        : "URL-encode next_after unchanged and preserve the problem filter. Live admission-order traversal; priority is within each eight-admission page, not across unseen candidates.",
    schema: { $ref: `${origin}/schemas/review-queue.v1.json#/properties/query/properties/${name}` },
  }));
}

export function reviewQueueResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!("GET " + path in REVIEW_QUEUE_PUBLIC_READS)) return undefined;
  if (path === "/reviews")
    return {
      "308": {
        description:
          "Permanent redirect to /reviews.md, preserving problem and after query parameters.",
        headers: { Location: { schema: { type: "string" } } },
      },
    };
  const format = path.slice("/reviews.".length);
  const media =
    format === "json" ? "application/json" : format === "md" ? "text/markdown" : "text/html";
  const problem = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        "At most eight admission candidates, selected using the canonical scientific fold. Current visibility is rechecked; missing data and read-budget exclusions are explicit. Recommendations are not review authority or a truth score.",
      headers: {
        ETag: { schema: { type: "string" } },
        "Cache-Control": {
          schema: { type: "string", const: "public, max-age=0, must-revalidate" },
        },
      },
      content: {
        [media]:
          format === "json"
            ? { schema: { $ref: `${origin}/schemas/review-queue.v1.json#/properties/response` } }
            : {},
      },
    },
    "304": {
      description:
        "Unchanged representation after rechecking current public visibility. No response body.",
    },
    "400": {
      description: "Invalid or repeated problem/after parameter; no database read.",
      content: problem,
    },
    "500": {
      description: "Opaque unavailable response; never an invented empty queue.",
      content: problem,
    },
  };
}
