/** The public artifact gateway is mounted outside the Hono app. These entries
 * disclose its byte-only publication and owner recovery contracts together. */
export const ARTIFACT_PUBLICATION_OPERATIONS: readonly [
  string,
  "public" | "fellow-bearer",
  string,
  string?,
][] = [
  [
    "POST /v1/artifacts/:uploadId/publish",
    "fellow-bearer",
    "Accept explicit CC-BY-4.0 publication of an owned verified upload bound to exact current evidence. The 202 receipt records queued delivery; artifact verification is bytes-only.",
    "artifact-publications:request",
  ],
  [
    "GET /v1/artifact-publications/:publicationId",
    "fellow-bearer",
    "Read owned publication delivery status and its optional held recovery action. Release authorization is irreversible; a public download appears only after delivery.",
  ],
  [
    "POST /v1/artifact-publications/:publicationId/retry",
    "fellow-bearer",
    "Requeue an eligible held publication when its exact evidence and target are available again. Use the recovery generation from private status. At most eight owner recoveries retain the original publication, consent and three-screen budget.",
    "artifact-publications:retry_request",
  ],
  [
    "GET /p/:problem/artifacts/:publicationId.json",
    "public",
    "Read delivered artifact provenance with current evidence and target visibility. Verification is bytes-only; this face accepts no query parameters and also supports HEAD.",
  ],
  [
    "GET /p/:problem/evidence/:evidenceId/artifacts.json",
    "public",
    "Read up to twenty delivered artifact manifests for exact evidence, using after and through delivery cursors. Current source visibility applies to every page; HEAD is supported.",
  ],
];

type ArtifactPublicationOperation = "publish" | "status" | "retry" | "manifest" | "evidence";
function operation(path: string, method: string): ArtifactPublicationOperation | undefined {
  if (method === "POST") {
    if (path === "/v1/artifacts/{uploadId}/publish") return "publish";
    if (path === "/v1/artifact-publications/{publicationId}/retry") return "retry";
  }
  if (method === "GET") {
    if (path === "/v1/artifact-publications/{publicationId}") return "status";
    if (path === "/p/{problem}/artifacts/{publicationId}.json") return "manifest";
    if (path === "/p/{problem}/evidence/{evidenceId}/artifacts.json") return "evidence";
  }
  return undefined;
}

export function artifactPublicationParameters(
  path: string,
  origin: string,
  method: string,
): readonly unknown[] {
  const kind = operation(path, method);
  if (kind === "publish" || kind === "retry")
    return [
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          kind === "retry"
            ? "Reuse the same key and exact body to recover the immutable accepted retry receipt. A later recovery uses a new key and the expected_retry_generation advertised by private status."
            : "Reuse the same key and exact consent body to recover the original publication acceptance receipt.",
        schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      },
    ];
  if (kind !== "evidence") return [];
  return ["after", "through"].map((name) => ({
    name,
    in: "query",
    required: false,
    description:
      name === "after"
        ? "Nonnegative safe-integer delivery cursor. Use next_after for continuation or poll_path for newly delivered artifacts; omitted after starts at zero."
        : "Pinned delivery cutoff from the first page, at least after. Keep it unchanged while following next_path. Omit it for a new delivery snapshot.",
    schema: {
      $ref: `${origin}/schemas/artifact-publications.v1.json#/properties/evidence_artifacts/properties/${name}`,
    },
  }));
}

export function artifactPublicationResponses(
  path: string,
  origin: string,
  method: string,
): Readonly<Record<string, unknown>> | undefined {
  const kind = operation(path, method);
  if (kind === undefined) return undefined;
  const root =
    kind === "publish"
      ? "receipt"
      : kind === "retry"
        ? "retry_receipt"
        : kind === "evidence"
          ? "evidence_artifacts"
          : kind;
  const accepted = kind === "publish" || kind === "retry";
  const isPublic = kind === "manifest" || kind === "evidence";
  const schema = `${origin}/schemas/artifact-publications.v1.json`;
  const problem = {
    "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
  };
  return {
    [accepted ? "202" : "200"]: {
      description:
        kind === "retry"
          ? "Immutable recovery acceptance with the new generation, original publication ID and private status path. Delivery remains queued."
          : kind === "publish"
            ? "Immutable consent acceptance for queued publication. Check the private status path for actual delivery."
            : kind === "status"
              ? "Private current delivery state. recovery is null unless this held job can request a bounded owner recovery; download_url is present only when published."
              : "Public byte-only artifact provenance after current source checks.",
      content: { "application/json": { schema: { $ref: `${schema}#/properties/${root}` } } },
      headers: {
        "Cache-Control": {
          schema: { type: "string", const: isPublic ? "no-store" : "private, no-store" },
        },
        ...(isPublic
          ? { ETag: { schema: { type: "string" } } }
          : { "X-Robots-Tag": { schema: { type: "string", const: "noindex, nofollow" } } }),
        ...(accepted
          ? {
              Location: {
                schema: { $ref: `${schema}#/properties/${root}/properties/status_path` },
              },
              "Retry-After": { schema: { type: "string", const: "30" } },
            }
          : {}),
      },
    },
    ...(isPublic
      ? {
          "304": {
            description: "Unchanged after current source and visibility checks; no response body.",
          },
        }
      : {}),
    ...(accepted
      ? {
          "409": {
            description:
              kind === "retry"
                ? "Generation, eligibility or replay conflict. Recover the original receipt with its unchanged key or refresh private status before requesting a later recovery."
                : "Publication or replay conflict. Recover the original acceptance with the unchanged request and key.",
            content: problem,
          },
        }
      : {}),
    default: {
      description:
        "Typed opaque refusal for invalid requests, unavailable sources, authorization or dependencies.",
      content: problem,
    },
  };
}
