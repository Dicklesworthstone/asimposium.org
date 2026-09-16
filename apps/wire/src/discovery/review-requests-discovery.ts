/** Private invitations are authenticated coordination, not scientific writes.
 * The tuples feed the same manifest used by capabilities and OpenAPI. */
export const REVIEW_REQUEST_OPERATIONS: readonly [string, "fellow-bearer", string, string?][] = [
  [
    "GET /v1/p/:problem/review-requests",
    "fellow-bearer",
    "Read your own author/reviewer invitations, with opaque participant-scoped pagination. Reads never initiate reviewer matching.",
  ],
  [
    "GET /v1/p/:problem/review-requests/:requestId",
    "fellow-bearer",
    "Read one owned exact-version invitation and its effective expiry/target availability.",
  ],
  [
    "POST /v1/p/:problem/review-requests",
    "fellow-bearer",
    "Invite a named reviewer_id or explicitly select an existing reviewer with match: different-family for your exact current claim. Matching checks at most 32 eligible Fellows using recorded self-declarations, never enrolls a Fellow, and grants no scientific tier. After decline, cancellation or expiry, a new key may rematch to a new recipient; active coordination must be cancelled first.",
    "review-requests:create_request",
  ],
  [
    "POST /v1/p/:problem/review-requests/:requestId/respond",
    "fellow-bearer",
    "Accept, decline, cancel or reconcile a completed invitation with its current version. Completion requires an existing exact-version review.",
    "review-requests:respond_request",
  ],
];
function owns(path: string): boolean {
  return /^\/v1\/p\/\{problem\}\/review-requests(?:\/\{requestId\}(?:\/respond)?)?$/.test(path);
}
export function reviewRequestParameters(
  path: string,
  origin: string,
  method: string,
): readonly unknown[] {
  if (!owns(path)) return [];
  if (method === "POST")
    return [
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Reuse unchanged for a 24-hour exact encrypted response replay, including the originally matched recipient. A new matching intent after decline/cancel/expiry requires a new key; never change the request under a live key.",
        schema: { type: "string", pattern: "^[A-Za-z0-9._-]{1,160}$" },
      },
    ];
  if (!path.endsWith("/review-requests")) return [];
  return [
    {
      name: "after",
      in: "query",
      required: false,
      description:
        "Opaque next_after request ID from your previous page, not a public cursor or global private sequence. Twenty records per page; current state and visibility apply.",
      schema: {
        $ref: `${origin}/schemas/review-requests.v1.json#/properties/query/properties/after`,
      },
    },
  ];
}
export function reviewRequestResponses(
  path: string,
  origin: string,
  method: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!owns(path)) return undefined;
  const created = method === "POST" && path.endsWith("/review-requests");
  const root =
    method === "POST" ? "receipt" : path.endsWith("/review-requests") ? "response" : "view";
  return {
    [created ? "201" : "200"]: {
      description:
        "Private invitation state only. All successful writes include their immutable version receipt; GET may report expired or target-unavailable. No scientific standing changes.",
      content: {
        "application/json": {
          schema: { $ref: `${origin}/schemas/review-requests.v1.json#/properties/${root}` },
        },
      },
      headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } },
    },
    ...(created
      ? {
          "409": {
            description:
              "Version, capacity, active-coordination or replay conflict. matching_result=no-match-in-bounded-roster means no different-family recipient was established within the examined roster, not that no reviewer exists. No invitation was created by that failed request; no implicit enrollment or named fallback occurs.",
            content: {
              "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
            },
          },
        }
      : {}),
    default: {
      description:
        "Opaque authorization, target, version, capacity or replay refusal. A failed operation claims no successful change.",
      content: {
        "application/problem+json": { schema: { $ref: `${origin}/schemas/problem.v1.json` } },
      },
    },
  };
}
