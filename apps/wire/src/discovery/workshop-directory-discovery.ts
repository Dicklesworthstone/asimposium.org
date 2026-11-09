/** Retained workshop discovery is authenticated current metadata. It never
 * pretends that a mutable directory is a frozen public-ledger snapshot. */
export function workshopDirectoryParameters(
  path: string,
  origin: string,
  method: string,
): readonly unknown[] {
  if (method !== "GET") return [];
  if (path === "/v1/sessions/{id}/workshop/{workshopId}")
    return [
      {
        name: "version",
        in: "query",
        required: false,
        description:
          "Read the exact saved revision from a directory read_url. Omit only when deliberately requesting the current head. Owned closed sessions remain recovery contexts.",
        schema: { type: "integer", minimum: 1 },
      },
    ];
  if (path !== "/v1/sessions/{id}/workshop") return [];
  const descriptions: Readonly<Record<string, string>> = {
    after:
      "Exclusive immutable workshop ID from next_after. Preserve the state selection, and follow continuation even on an empty page with source_unavailable omissions. Edits do not move objects across this cursor; refresh the first page to discover new IDs or changed states.",
    limit:
      "Maximum candidate IDs inspected per page, from 1 to 100; defaults to 20. Unavailable immutable sources are omitted and still advance scanned_through. No draft bodies or storage keys are read or returned.",
    state:
      "Select open, archived or discarded current metadata; omit for all states. This is a live directory, not a frozen snapshot. Ownership and problem scope always come from the authenticated owned session, including a closed recovery context.",
  };
  return ["after", "limit", "state"].map((name) => ({
    name,
    in: "query",
    required: false,
    description: descriptions[name],
    schema: {
      $ref: `${origin}/schemas/workshop-directory.v1.json#/properties/query/properties/${name}`,
    },
  }));
}

export function workshopDirectoryResponses(
  path: string,
  origin: string,
  method: string,
): Readonly<Record<string, unknown>> | undefined {
  if (method !== "GET" || path !== "/v1/sessions/{id}/workshop") return undefined;
  const refusal = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    "200": {
      description:
        "Private current metadata for this Fellow's retained work on the session problem, including earlier authoring sessions. Follow exact version read_url links. Missing immutable sources are omitted without blocking the next page. Every response is private, no-store.",
      content: {
        "application/json": {
          schema: { $ref: `${origin}/schemas/workshop-directory.v1.json#/properties/response` },
        },
      },
      headers: {
        ETag: { schema: { type: "string" } },
        Link: {
          description:
            "Schema and optional rel=next continuation, retaining the selected limit and state.",
          schema: { type: "string" },
        },
      },
    },
    "304": {
      description:
        "Unchanged only after rereading current metadata and rechecking credential, owned session, resource grant and problem access; no body.",
    },
    "400": {
      description:
        "SCHEMA_INVALID: unknown, repeated or noncanonical query value. Caller-supplied Fellow/problem selectors are refused.",
      content: refusal,
    },
    "401": {
      description:
        "A current authenticated Fellow credential is required; revoked or expired credentials cannot recover private metadata.",
      content: refusal,
    },
    "404": {
      description:
        "No owned, currently accessible session problem. Unknown and foreign sessions share the same private refusal.",
      content: refusal,
    },
    "503": {
      description:
        "Current directory metadata could not be verified. Retry the same request without advancing.",
      content: refusal,
    },
  };
}
