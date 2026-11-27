const directory = "/v1/sessions/{id}/syntheses";
const single = `${directory}/{synthesisId}`;

export function synthesisDraftRecoveryParameters(
  path: string,
  origin: string,
  method: string,
): readonly unknown[] {
  if (method !== "GET" || path !== directory) return [];
  const descriptions = {
    after:
      "Exclusive immutable synthesis ID from next_after. Preserve state; refresh the first page to discover new drafts or publication changes.",
    limit:
      "Number of metadata entries, from 1 to 100; defaults to 20. Full draft bodies and anchors are read only through each read_url.",
    state:
      "Select draft or published; omit for both. Ownership and problem scope come from the current Fellow and owned session, including closed recovery contexts.",
  };
  return (["after", "limit", "state"] as const).map((name) => ({
    name,
    in: "query",
    required: false,
    description: descriptions[name],
    schema: {
      $ref: `${origin}/schemas/syntheses.v1.json#/$defs/session_draft_query/properties/${name}`,
    },
  }));
}

export function synthesisDraftRecoveryResponses(
  path: string,
  origin: string,
  method: string,
): Readonly<Record<string, unknown>> | undefined {
  if (method !== "GET" || (path !== directory && path !== single)) return undefined;
  const refusal = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        path === directory
          ? "Private bounded current metadata for all of this Fellow's synthesis drafts on the session problem, including earlier sessions. Follow read_url for complete content and publication status. Publication pins may be submitted explicitly as shared_handoff at close, which revalidates the public source."
          : "Complete own private synthesis draft and current publication receipt. Publication read_url points to the canonical public synthesis; shared_handoff pins do not bypass current publication validation at close.",
      content: {
        "application/json": {
          schema: {
            $ref: `${origin}/schemas/syntheses.v1.json#/$defs/${path === directory ? "session_draft_index" : "session_draft"}`,
          },
        },
      },
      headers: { ETag: { schema: { type: "string" } }, Link: { schema: { type: "string" } } },
    },
    "304": {
      description:
        "Unchanged only after rechecking current credential, owned session, grant, problem access and retained source. All responses are private, no-store.",
    },
    "400": {
      description:
        "SCHEMA_INVALID: unknown, repeated or noncanonical query value. Exact reads take no query parameters.",
      content: refusal,
    },
    "401": { description: "Current authenticated Fellow credential required.", content: refusal },
    "404": {
      description:
        "WORKSHOP_NOT_FOUND: no own retained draft or currently accessible owned session. Foreign and unknown identifiers receive the same private refusal.",
      content: refusal,
    },
    "503": {
      description:
        "Current private recovery could not be verified. Retry without advancing continuation.",
      content: refusal,
    },
  };
}
