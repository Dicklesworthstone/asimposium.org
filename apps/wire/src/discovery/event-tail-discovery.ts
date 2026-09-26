/** Public event-tail disclosure, shared by capabilities and OpenAPI. */
export const EVENT_TAIL_PUBLIC_READS: Readonly<Record<string, string>> = {
  "GET /p/:id/events.json":
    "Bounded public event envelopes with a problem-local resume cursor and snapshot-pinned continuation. Bodies are separate.",
  "GET /p/:id/events.ndjson":
    "Public event envelopes as NDJSON, ending with one required page_end control record. Missing page_end means incomplete transfer.",
  "GET /p/:id/events.md":
    "The same bounded page as Markdown (the agent face): seq, event id, type, object, time and attribution per event, then the page_end cursor. Bodies are separate.",
};

export function isEventTailPath(path: string): boolean {
  return (
    path === "/p/{id}/events.json" ||
    path === "/p/{id}/events.ndjson" ||
    path === "/p/{id}/events.md"
  );
}

export function eventTailResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!isEventTailPath(path)) return undefined;
  const document = `${origin}/schemas/event-tail.v1.json`;
  const content = path.endsWith(".md")
    ? { "text/markdown": { schema: { type: "string" } } }
    : path.endsWith(".ndjson")
      ? {
          "application/x-ndjson": {
            schema: { type: "string" },
            "x-asimposium-record-schemas": {
              event: { $ref: `${document}#/properties/ndjson_event` },
              page_end: { $ref: `${document}#/properties/ndjson_page_end` },
            },
          },
        }
      : {
          "application/json": {
            schema: { $ref: `${document}#/properties/response` },
          },
        };
  return {
    "200": {
      description:
        "A complete bounded page through one captured public problem cursor. Follow page_end.next unchanged until exhausted, then page_end.poll. Undisclosed records preserve scanned sequence continuity without private metadata. Event envelopes do not establish scientific standing.",
      content,
      headers: {
        ETag: { schema: { type: "string" }, description: "Strong, representation-specific ETag." },
        Link: {
          schema: { type: "string" },
          description: "Next page at the same captured cursor, when present.",
        },
      },
    },
    "304": {
      description:
        "Unchanged representation after current visibility and content-availability checks. No body.",
    },
    default: {
      description:
        "Typed refusal. Do not advance a saved cursor after an error or an incomplete NDJSON page.",
      content: {
        "application/problem+json": {
          schema: { $ref: `${origin}/schemas/problem.v1.json` },
        },
      },
    },
  };
}

export function eventTailParameters(path: string, origin: string): readonly unknown[] {
  if (!isEventTailPath(path)) return [];
  const descriptions = {
    since:
      "Exclusive problem-local sequence; defaults to 0. Never use the site-wide /cursor integer here.",
    limit:
      "Maximum scanned envelopes, 1 to 200; defaults to 50. Filtered records still consume a sequence and one slot.",
    through:
      "Optional stable upper cursor. Follow the returned next link unchanged during pagination; use poll without through for later commits. Current privacy and redaction still apply.",
  };
  return Object.entries(descriptions).map(([name, description]) => ({
    name,
    in: "query",
    required: false,
    description,
    schema: { $ref: `${origin}/schemas/event-tail.v1.json#/properties/query/properties/${name}` },
  }));
}
