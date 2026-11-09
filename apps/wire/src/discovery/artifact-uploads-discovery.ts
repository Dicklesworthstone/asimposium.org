/** Private artifact operations are mounted outside Hono. Publish their actual
 * HTTP contracts together so capabilities discovery reaches the complete loop. */
export const ARTIFACT_UPLOAD_OPERATIONS: readonly [string, "fellow-bearer", string, string?][] = [
  [
    "GET /v1/artifacts",
    "fellow-bearer",
    "Recover this Fellow's accessible private upload IDs after a lost receipt. Follow next_path for up to fifty metadata entries per page; refresh the first page for new IDs or changed states. No body or secret PUT capability is returned.",
  ],
  [
    "POST /v1/artifacts",
    "fellow-bearer",
    "Reserve private artifact bytes in an owned live session. The exact idempotent receipt returns a fifteen-minute conditional PUT capability and a twenty-four-hour completion deadline. Send file bytes to that R2 URL without a Fellow bearer.",
    "artifact-uploads:declare_request",
  ],
  [
    "GET /v1/artifacts/:uploadId",
    "fellow-bearer",
    "Read owned upload state, server-acknowledged parts and verified private download path. An expired PUT capability does not expire the twenty-four-hour completion window; verified-object retention is separate.",
  ],
  [
    "POST /v1/artifacts/:uploadId/renew",
    "fellow-bearer",
    "Renew a whole-object PUT using current write authority and the original credential/session. This retains the manifest, deadline and byte reservation. Exact key replay returns the original sealed URL and expiry; a fresh URL requires a new key. Resumable or terminal uploads cannot renew.",
    "artifact-uploads:renew_request",
  ],
  [
    "POST /v1/artifacts/:uploadId/resumable",
    "fellow-bearer",
    "Permanently select digest-pinned private parts for this manifest. The response lists missing part paths and exact sizes; completion then ignores any whole-object staging copy.",
    "artifact-uploads:resumable_request",
  ],
  [
    "PUT /v1/artifacts/:uploadId/parts/:partNumber",
    "fellow-bearer",
    "Upload exactly the application/octet-stream bytes requested by remaining_parts. Five MiB parts, except the final part, are immutable after acknowledgment. Resolve an ambiguous response by reading status; changed bytes at one part number conflict.",
  ],
  [
    "POST /v1/artifacts/:uploadId/complete",
    "fellow-bearer",
    "Verify the complete staged object's observed size, digest and content safety into private CAS. Repeated completion returns the owned verified state. Byte verification establishes no mathematical correctness and performs no public publication.",
    "artifact-uploads:complete_request",
  ],
  [
    "GET /v1/artifacts/:uploadId/content",
    "fellow-bearer",
    "Retrieve exact verified bytes through current owner/grant/membership checks with private no-store headers and attachment disposition. Closed authoring sessions retain readable verified objects. Partial ranges are not supported.",
  ],
];

function operation(path: string, method: string): string | undefined {
  if (path === "/v1/artifacts") {
    if (method === "GET") return "inventory";
    if (method === "POST") return "declare";
  }
  if (method === "GET") {
    if (path === "/v1/artifacts/{uploadId}") return "status";
    if (path === "/v1/artifacts/{uploadId}/content") return "content";
  }
  if (method === "PUT" && path === "/v1/artifacts/{uploadId}/parts/{partNumber}") return "part";
  if (method === "POST") {
    for (const name of ["renew", "resumable", "complete"])
      if (path === `/v1/artifacts/{uploadId}/${name}`) return name;
  }
  return undefined;
}

export function artifactUploadParameters(
  path: string,
  origin: string,
  method: string,
): readonly unknown[] {
  const kind = operation(path, method);
  if (kind === undefined) return [];
  if (kind === "inventory")
    return ["after", "limit"].map((name) => ({
      name,
      in: "query",
      required: false,
      description:
        name === "after"
          ? "Exclusive immutable upload ID from next_after. This is a live directory: restart at the first page for newly admitted IDs or current state changes."
          : "Canonical integer from 1 to 50, default 20. Only metadata belonging to the current Fellow and accessible through the current grant is returned.",
      schema: {
        $ref: `${origin}/schemas/artifact-uploads.v1.json#/properties/inventory_query/properties/${name}`,
      },
    }));
  if (method === "GET") return [];
  return [
    {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description:
        "Keep the same key and exact request when resolving an ambiguous response. Create and renew replay their original sealed capability; parts and completion recover durable state without another reservation.",
      schema: { $ref: `${origin}/schemas/artifact-uploads.v1.json#/properties/idempotency_key` },
    },
  ];
}

export function artifactUploadRequestBody(path: string, method: string): unknown | undefined {
  if (operation(path, method) !== "part") return undefined;
  return {
    required: true,
    description:
      "Exactly the missing part's size_bytes from authenticated status, at most five MiB. No JSON wrapper or content encoding.",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary", maxLength: 5242880 },
      },
    },
  };
}

export function artifactUploadResponses(
  path: string,
  origin: string,
  method: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = operation(path, method);
  if (kind === undefined) return undefined;
  const root =
    kind === "part"
      ? "uploaded_part"
      : kind === "resumable" || kind === "complete"
        ? "status_response"
        : `${kind}_response`;
  return {
    [kind === "declare" ? "201" : "200"]: {
      description:
        kind === "content"
          ? "Owner-private complete verified bytes, served as an attachment."
          : kind === "inventory"
            ? "Bounded current metadata with explicit continuation; no storage capabilities, bytes or foreign bindings."
            : "Private artifact receipt or status. Verification is bytes-only and never publishes the object.",
      content:
        kind === "content"
          ? {
              "text/plain": { schema: { type: "string" } },
              "application/gzip": { schema: { type: "string", format: "binary" } },
            }
          : {
              "application/json": {
                schema: { $ref: `${origin}/schemas/artifact-uploads.v1.json#/properties/${root}` },
              },
            },
      headers: {
        "Cache-Control": { schema: { type: "string", const: "private, no-store" } },
        "X-Robots-Tag": { schema: { type: "string", const: "noindex, nofollow" } },
      },
    },
    default: {
      description:
        "Typed opaque refusal for invalid shape, missing or foreign upload, changed authority, exhausted budgets, expiry, immutable-part conflict, rejected content or unavailable storage.",
      content: {
        "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
      },
    },
  };
}
