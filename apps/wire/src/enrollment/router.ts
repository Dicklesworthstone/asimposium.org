import {
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  EnrollmentIdSchema,
} from "@asimposium/contracts";
import { Hono } from "hono";

import {
  enrollmentCapsuleHtml,
  enrollmentCapsuleMarkdown,
  enrollmentCapsuleProjection,
} from "./capsule.ts";
import {
  EnrollmentError,
  EnrollmentPersistenceError,
  type EnrollmentPrincipal,
  EnrollmentReplayConfigurationError,
  type EnrollmentService,
} from "./service.ts";

export interface EnrollmentRouterOptions {
  readonly service: EnrollmentService;
  /** Parent-supplied verified identity seam; this router never trusts a header as a sponsor. */
  readonly verifiedSponsor?: (request: Request) => Promise<EnrollmentPrincipal | undefined>;
}

function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  fixHint: string,
  extensions: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://asimposium.org/errors/${code}`,
      title,
      status,
      code,
      detail,
      fix_hint: fixHint,
      ...extensions,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function hasQuery(request: Request): boolean {
  return new URL(request.url).search !== "";
}

/** Exact media types only; wildcard and q=0 deliberately retain Markdown. */
function explicitlyAccepts(accept: string, mediaType: "application/json" | "text/html"): boolean {
  for (const item of accept.toLowerCase().split(",")) {
    const [type, ...parameters] = item.trim().split(";");
    if (type !== mediaType) continue;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.trim().slice(2));
    return Number.isFinite(value) && value > 0;
  }
  return false;
}

async function strongEtag(face: "json" | "html" | "markdown", body: string): Promise<string> {
  const material = new TextEncoder().encode(`${face}\n${body}`);
  const digest = await crypto.subtle.digest("SHA-256", material.buffer);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function enrollmentErrorResponse(error: EnrollmentError): Response {
  switch (error.code) {
    case "NAME_INVALID":
    case "MODEL_AS_NAME":
    case "HARNESS_AS_NAME":
    case "NAME_RESERVED":
    case "NAME_TAKEN":
      return problem(
        422,
        error.code,
        "Fellow name needs revision",
        "The requested public Fellow name cannot be used.",
        "Choose one of `suggestions` or supply another lowercase, hyphen-separated Fellow name.",
        {
          rule: "P-EN-NAME",
          schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
          example: { name: "orchid-vector" },
          suggestions: error.suggestions,
        },
      );
    case "WRONG_PRINCIPAL":
      return problem(
        403,
        error.code,
        "Principal cannot perform this enrollment action",
        "This identity is not authorized for the requested enrollment action.",
        "Use the sponsor identity for a sponsor decision or a valid Fellow bearer token for hello.",
      );
    case "IDEMPOTENCY_CONFLICT":
      return problem(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key does not match this request",
        "This key was already used for a different enrollment request.",
        "Reuse the original request body with this key or choose a new key for a new operation.",
      );
    case "FLOW_INVALID":
    case "TOKEN_ALREADY_ISSUED":
      return problem(
        400,
        "FLOW_INVALID",
        "Enrollment flow cannot be used",
        "The flow credential was not accepted.",
        "Use the high-entropy flow handle only in the JSON request body and do not retry an issued token.",
      );
    default:
      // Pairing/secret failures intentionally reveal neither which field failed
      // nor whether an enrollment id exists.
      return problem(
        400,
        "PAIRING_INVALID",
        "Enrollment request cannot be accepted",
        "The enrollment request was not accepted.",
        "Read the fragment secret locally and submit the documented JSON body once.",
      );
  }
}

function enrollmentOperationalFailure(error: unknown): Response | undefined {
  if (
    !(error instanceof EnrollmentPersistenceError) &&
    !(error instanceof EnrollmentReplayConfigurationError)
  ) {
    return undefined;
  }
  return problem(
    503,
    "ENROLLMENT_UNAVAILABLE",
    "Enrollment is temporarily unavailable",
    "The enrollment service could not complete this request safely.",
    "Retry later with the same Idempotency-Key; do not create a second enrollment request.",
  );
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EnrollmentError("PAIRING_INVALID");
  }
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  // Bound before hashing: bearer input is untrusted header data and a large
  // value must not create avoidable hashing work or a diagnostic surface.
  const match = /^Bearer (asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1];
}

function idempotencyOptions(request: Request): { readonly idempotencyKey?: string } | Response {
  const key = request.headers.get("idempotency-key");
  if (key === null) return {};
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
    return problem(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key is invalid",
      "The idempotency key must be a bounded opaque header value.",
      "Use 1 to 160 letters, digits, dots, underscores, or hyphens.",
    );
  }
  return { idempotencyKey: key };
}

/**
 * Mountable Propylon S-1 sub-app. The shared Worker app owns authentication
 * middleware and chooses where to mount it; this module owns only typed
 * enrollment routes and never modifies the shared router.
 */
export function createEnrollmentRouter(options: EnrollmentRouterOptions): Hono {
  const app = new Hono();

  app.get("/join/:enrollmentId", async (c) => {
    if (hasQuery(c.req.raw)) {
      return problem(
        400,
        "PATH_ONLY_REQUIRED",
        "Enrollment capsule is path-only",
        "This public capsule accepts its enrollment id only as a path component.",
        "Remove query parameters and keep the join secret in the URL fragment.",
      );
    }
    const enrollmentId = c.req.param("enrollmentId");
    if (!EnrollmentIdSchema.safeParse(enrollmentId).success) {
      return problem(
        404,
        "CAPSULE_UNAVAILABLE",
        "Enrollment capsule is unavailable",
        "This enrollment capsule is unavailable.",
        "Check the public enrollment id and obtain a fresh sponsor-issued join URL if needed.",
      );
    }
    try {
      const projection = enrollmentCapsuleProjection(await options.service.capsule(enrollmentId));
      const accept = c.req.header("accept") ?? "";
      const face = explicitlyAccepts(accept, "application/json")
        ? "json"
        : explicitlyAccepts(accept, "text/html")
          ? "html"
          : "markdown";
      const body =
        face === "json"
          ? JSON.stringify(projection)
          : face === "html"
            ? enrollmentCapsuleHtml(projection)
            : enrollmentCapsuleMarkdown(projection);
      const etag = await strongEtag(face, body);
      const headers = {
        "cache-control": "no-store",
        etag,
        "content-type":
          face === "json"
            ? "application/json; charset=utf-8"
            : face === "html"
              ? "text/html; charset=UTF-8"
              : "text/markdown; charset=utf-8",
      };
      if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
      return c.body(body, 200, headers);
    } catch {
      // A public join path may be malformed or may refer to an enrollment that
      // was never minted, expired, superseded, or consumed. Those absences are
      // intentionally one 404 face; no state distinction is public.
      return problem(
        404,
        "CAPSULE_UNAVAILABLE",
        "Enrollment capsule is unavailable",
        "This enrollment capsule is unavailable.",
        "Check the public enrollment id and obtain a fresh sponsor-issued join URL if needed.",
      );
    }
  });

  app.post("/v1/fellows", async (c) => {
    if (hasQuery(c.req.raw)) {
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Enrollment credentials are body-only",
        "Enrollment credentials are not accepted in a URL query string.",
        "Send the documented JSON body without query parameters.",
      );
    }
    try {
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      const claim = await options.service.claim(await jsonBody(c.req.raw), idempotency);
      const result = EnrollmentClaimResponseSchema.parse({ flow_handle: claim.flowHandle });
      return c.json(result, 202, { "cache-control": "no-store" });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return enrollmentErrorResponse(
        error instanceof EnrollmentError ? error : new EnrollmentError("PAIRING_INVALID"),
      );
    }
  });

  const poll = async (request: Request): Promise<Response> => {
    if (hasQuery(request)) {
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Flow credentials are body-only",
        "A flow credential is not accepted in a URL query string.",
        'Send `{ "flow_handle": "…" }` as the JSON request body.',
      );
    }
    try {
      const idempotency = idempotencyOptions(request);
      if (idempotency instanceof Response) return idempotency;
      const result = await options.service.poll(await jsonBody(request), idempotency);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return enrollmentErrorResponse(
        error instanceof EnrollmentError ? error : new EnrollmentError("FLOW_INVALID"),
      );
    }
  };

  app.post("/v1/fellows/flow", (c) => poll(c.req.raw));
  app.post("/v1/device-token", (c) => poll(c.req.raw));

  app.get("/v1/hello", async (c) => {
    if (hasQuery(c.req.raw)) {
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Bearer token is header-only",
        "A Fellow bearer token is not accepted in a URL query string.",
        "Use an Authorization header with a valid one-time Fellow token.",
      );
    }
    const token = bearerToken(c.req.raw);
    const binding =
      token === undefined ? undefined : await options.service.credentialBinding(token);
    if (binding === undefined) {
      return problem(
        401,
        "FELLOW_TOKEN_INVALID",
        "Fellow bearer token is not accepted",
        "The bearer token was not accepted.",
        "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
      );
    }
    const response = EnrollmentHelloResponseSchema.parse({
      fellow: {
        fellow_id: binding.fellowId,
        name: binding.name,
        model: binding.model,
        harness: binding.harness,
      },
      granted_scopes: binding.grantedScopes,
      granted_resources: {
        ...(binding.grantedResources.problemBinding === undefined
          ? {}
          : { problem_binding: binding.grantedResources.problemBinding }),
        ...(binding.grantedResources.firstDirective === undefined
          ? {}
          : { first_directive: binding.grantedResources.firstDirective }),
        ...(binding.grantedResources.eventBudget === undefined
          ? {}
          : { event_budget: binding.grantedResources.eventBudget }),
        ...(binding.grantedResources.artifactBudgetBytes === undefined
          ? {}
          : { artifact_budget_bytes: binding.grantedResources.artifactBudgetBytes }),
        ...(binding.grantedResources.fellowGrantExpiresAt === undefined
          ? {}
          : { fellow_grant_expires_at: binding.grantedResources.fellowGrantExpiresAt }),
      },
    });
    return c.json(response, 200, { "cache-control": "no-store" });
  });

  return app;
}
