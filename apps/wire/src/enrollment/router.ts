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
import { EnrollmentError, type EnrollmentService } from "./service.ts";

export interface EnrollmentRouterOptions {
  readonly service: EnrollmentService;
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
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  return match?.[1];
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
        "PAIRING_INVALID",
        "Enrollment capsule is unavailable",
        "This enrollment capsule is unavailable.",
        "Check the public enrollment id and obtain a fresh sponsor-issued join URL if needed.",
      );
    }
    try {
      const projection = enrollmentCapsuleProjection(await options.service.capsule(enrollmentId));
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) {
        return c.json(projection, 200, { "cache-control": "no-store" });
      }
      if (accept.includes("text/html")) {
        return c.html(enrollmentCapsuleHtml(projection), 200, { "cache-control": "no-store" });
      }
      return c.text(enrollmentCapsuleMarkdown(projection), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
    } catch (error) {
      return enrollmentErrorResponse(
        error instanceof EnrollmentError ? error : new EnrollmentError("PAIRING_INVALID"),
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
      const claim = await options.service.claim(await jsonBody(c.req.raw));
      const result = EnrollmentClaimResponseSchema.parse({ flow_handle: claim.flowHandle });
      return c.json(result, 202, { "cache-control": "no-store" });
    } catch (error) {
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
      const result = await options.service.poll(await jsonBody(request));
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
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
