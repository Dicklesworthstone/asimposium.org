/** The human case workflow is private. Only neutral notices are public reads. */
export const INTEGRITY_NOTICE_PUBLIC_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /p/:id/integrity": "Redirect to neutral scientific-integrity notices (Markdown).",
  "GET /p/:id/integrity.json":
    "Neutral review notices and exact correction links; no restricted case material (JSON).",
  "GET /p/:id/integrity.md": "Neutral review notices and exact correction links (Markdown).",
  "GET /p/:id/integrity.html": "Neutral review notices and exact correction links (HTML).",
});

function owns(path: string): boolean {
  return /^\/p\/\{id\}\/integrity(?:\.(?:json|md|html))?$/.test(path);
}

export function integrityNoticeParameters(path: string, origin: string): readonly unknown[] {
  return owns(path)
    ? [
        {
          name: "after",
          in: "query",
          required: false,
          description:
            "Exclusive case identifier from next_after. Follow unchanged even when withheld source content leaves a page empty. The case status and content permissions are current at each read.",
          schema: {
            $ref: `${origin}/schemas/integrity-cases.v1.json#/properties/public_query/properties/after`,
          },
        },
      ]
    : [];
}

export function integrityNoticeResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!owns(path)) return undefined;
  if (!/\.(?:json|md|html)$/.test(path))
    return {
      "308": {
        description: "Redirect to the Markdown notice collection, preserving its continuation.",
        headers: { Location: { schema: { type: "string" } } },
      },
    };
  const content = path.endsWith(".json")
    ? {
        "application/json": {
          schema: { $ref: `${origin}/schemas/integrity-cases.v1.json#/properties/public_notices` },
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
        "At most 20 scanned case notices, in case-ID order. Only currently readable publication pins and neutral open/concluded states are exposed. Allegations, responses, investigator rationale and outcomes remain restricted; the notice changes no scientific standing.",
      content,
      headers: {
        ETag: { schema: { type: "string" } },
        Link: { schema: { type: "string" } },
        "Content-Location": { schema: { type: "string" } },
      },
    },
    "304": { description: "Unchanged after rechecking current source visibility; no body." },
    "400": { description: "Unknown, repeated or invalid continuation.", content: error },
    "404": { description: "The public problem is unavailable or withheld.", content: error },
    "503": {
      description: "The current notice projection could not be verified; retry unchanged.",
      content: error,
    },
  };
}
