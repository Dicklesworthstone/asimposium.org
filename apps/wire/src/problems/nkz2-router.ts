/**
 * HTTP sub-router for Fable §6.1 synthesis draft publication and Fable §6.2 /
 * 2026-11-02 operator-audited external expert review records (bead nkz2).
 *
 * Mounted alongside the screening appeals app on Stoa's enrollment router.
 * Every route requires Agora's signed service envelope (`verifiedSponsor` or
 * `verifiedOperator`) and never consults browser cookies or Fellow tokens.
 */

import {
  PublicLedgerProblemIdSchema,
  SYNTHESES_SCHEMA_ID,
  SynthesisIdSchema,
} from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseAuthenticatedJsonBytes } from "../auth/http";
import type { EnrollmentRouterOptions } from "../enrollment/router";
import { validatedProblem } from "../http/envelope";
import { listExternalExpertReviews, recordExternalExpertReview } from "./external-expert-reviews";
import { listSynthesisDraftsForSponsor, publishSynthesisDraftForSponsor } from "./synthesis-drafts";

const PROBLEMS_SCHEMA_URL = "https://a.asimposium.org/schemas/problems.v1.json";

function privateResponse(response: Response) {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function hasQueryParams(request: Request): boolean {
  return new URL(request.url).search !== "";
}

function isJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function queryNotAllowedProblem(path: string) {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "Query parameters are not accepted on this route",
      detail: `${path} accepts no URL query parameters.`,
      fixHint: `Remove query parameters from ${path}.`,
      rule: "A5",
      extensions: {
        schema: SYNTHESES_SCHEMA_ID,
        example: { path },
      },
    }),
  );
}

function invalidIdProblem(detail: string, fixHint: string, example: Record<string, unknown>) {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "Invalid path identifier",
      detail,
      fixHint,
      rule: "A5",
      extensions: {
        schema: SYNTHESES_SCHEMA_ID,
        example,
      },
    }),
  );
}

export function createSynthesisDraftsAndExternalReviewsApp(
  options: Pick<EnrollmentRouterOptions, "db" | "verifiedSponsor" | "verifiedOperator">,
) {
  const app = new Hono();

  app.get("/v1/sponsors/problems/:id/syntheses/drafts", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/sponsors/problems/:id/syntheses/drafts");
    }
    if (!options.verifiedSponsor || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "ENROLLMENT_UNAVAILABLE",
          title: "Synthesis draft listing is not configured",
          detail: "Sponsor authentication or storage is unavailable on this Worker.",
          fixHint: "Configure sponsor service-envelope verification and D1, then retry.",
        }),
      );
    }
    const problemId = c.req.param("id");
    const route = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/syntheses/drafts`;
    const authenticated = await options.verifiedSponsor(
      c.req.raw,
      route,
      "sponsor.syntheses.drafts.list",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (authenticated.principal.type !== "sponsor") {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "A sponsor principal is required",
          detail: "Only an authenticated sponsor may list private synthesis drafts.",
          fixHint: "Use the authenticated sponsor console.",
        }),
      );
    }
    if (!PublicLedgerProblemIdSchema.safeParse(problemId).success) {
      return invalidIdProblem(
        "The problem id in the path does not match the canonical pattern.",
        "Use a canonical problem id such as P-1.",
        { problem_id: "P-1" },
      );
    }
    const list = await listSynthesisDraftsForSponsor(
      options.db,
      problemId,
      authenticated.principal.sponsorId,
    );
    return privateResponse(c.json(list, 200));
  });

  app.post("/v1/sponsors/problems/:id/syntheses/:synthId/publish", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/sponsors/problems/:id/syntheses/:synthId/publish");
    }
    if (!options.verifiedSponsor || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "ENROLLMENT_UNAVAILABLE",
          title: "Synthesis draft publication is not configured",
          detail: "Sponsor authentication or storage is unavailable on this Worker.",
          fixHint: "Configure sponsor service-envelope verification and D1, then retry.",
        }),
      );
    }
    const problemId = c.req.param("id");
    const synthId = c.req.param("synthId");
    const route = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/syntheses/${encodeURIComponent(synthId)}/publish`;
    const authenticated = await options.verifiedSponsor(
      c.req.raw,
      route,
      "sponsor.syntheses.drafts.publish",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (authenticated.principal.type !== "sponsor") {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "A sponsor principal is required",
          detail: "Only an authenticated sponsor or steward may publish a draft synthesis.",
          fixHint: "Use the authenticated sponsor console.",
        }),
      );
    }
    if (
      !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
      !SynthesisIdSchema.safeParse(synthId).success
    ) {
      return invalidIdProblem(
        "The problem or synthesis id in the path does not match the canonical pattern.",
        "Provide a valid problem id and SYNTH-... draft identifier.",
        { problem_id: "P-1", synthesis_id: `SYNTH-${"0".repeat(26)}` },
      );
    }
    const result = await publishSynthesisDraftForSponsor(
      options.db,
      problemId,
      synthId,
      authenticated.principal.sponsorId,
    );
    if (!result.ok) {
      if (result.code === "WRITE_REFUSED" || result.code === "WORKSHOP_NOT_FOUND") {
        return privateResponse(
          validatedProblem({
            status: result.status,
            code: result.code,
            title: "Cannot publish synthesis draft",
            detail: result.detail,
            fixHint:
              result.code === "WRITE_REFUSED"
                ? "Sign in as a problem steward or the authoring Fellow's sponsor."
                : "Verify the synthesis draft identifier on the sponsor console.",
          }),
        );
      }
      return privateResponse(
        validatedProblem({
          status: result.status,
          code: result.code,
          title: "Cannot publish synthesis draft",
          detail: result.detail,
          fixHint: "Check the problem state and draft anchors before retrying.",
          rule:
            result.code === "SYNTHESIS_UNANCHORED"
              ? "P13"
              : result.code === "SECRET_SHAPED_CONTENT"
                ? "P7"
                : result.code === "CLAIMS_BOARD_LOCKED"
                  ? "P3"
                  : "A5",
          extensions: {
            schema: SYNTHESES_SCHEMA_ID,
            example: { problem_id: problemId, synthesis_id: synthId },
          },
        }),
      );
    }
    return privateResponse(c.json(result.body, result.status));
  });

  app.get("/v1/operators/problems/:id/external-expert-reviews", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/operators/problems/:id/external-expert-reviews");
    }
    if (!options.verifiedOperator || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "OPERATOR_AUTH_UNAVAILABLE",
          title: "Operator external expert review reads are not configured",
          detail: "Operator authentication or storage is unavailable on this Worker.",
          fixHint: "Configure operator service-envelope verification and D1, then retry.",
        }),
      );
    }
    const problemId = c.req.param("id");
    const route = `/v1/operators/problems/${encodeURIComponent(problemId)}/external-expert-reviews`;
    const authenticated = await options.verifiedOperator(
      c.req.raw,
      route,
      "operator.external-expert-reviews.list",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (authenticated.principal.type !== "operator") {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "An operator principal is required",
          detail: "Only an authenticated operator may inspect external expert review records.",
          fixHint: "Use an operator-authorized request.",
        }),
      );
    }
    if (!PublicLedgerProblemIdSchema.safeParse(problemId).success) {
      return invalidIdProblem(
        "The problem id in the path does not match the canonical pattern.",
        "Use a canonical problem id such as P-1.",
        { problem_id: "P-1" },
      );
    }
    const reviews = await listExternalExpertReviews(options.db, problemId);
    return privateResponse(c.json({ problem_id: problemId, reviews }, 200));
  });

  app.post("/v1/operators/problems/:id/external-expert-reviews", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/operators/problems/:id/external-expert-reviews");
    }
    if (!isJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return privateResponse(
        validatedProblem({
          status: 415,
          code: "SCHEMA_INVALID",
          title: "Content-Type application/json is required",
          detail:
            "/v1/operators/problems/:id/external-expert-reviews requires Content-Type: application/json.",
          fixHint: "Send header Content-Type: application/json with the JSON body.",
          rule: "A5",
          extensions: {
            schema: PROBLEMS_SCHEMA_URL,
            example: { content_type: "application/json" },
          },
        }),
      );
    }
    if (!options.verifiedOperator || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "OPERATOR_AUTH_UNAVAILABLE",
          title: "Operator external expert review writes are not configured",
          detail: "Operator authentication or storage is unavailable on this Worker.",
          fixHint: "Configure operator service-envelope verification and D1, then retry.",
        }),
      );
    }
    const problemId = c.req.param("id");
    const route = `/v1/operators/problems/${encodeURIComponent(problemId)}/external-expert-reviews`;
    const authenticated = await options.verifiedOperator(
      c.req.raw,
      route,
      "operator.external-expert-reviews.create",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (
      authenticated.principal.type !== "operator" ||
      !(authenticated.rawBody instanceof Uint8Array)
    ) {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "An operator principal is required",
          detail: "Only an authenticated operator may record external expert review attestations.",
          fixHint: "Use an operator-authorized request.",
        }),
      );
    }
    if (!PublicLedgerProblemIdSchema.safeParse(problemId).success) {
      return invalidIdProblem(
        "The problem id in the path does not match the canonical pattern.",
        "Use a canonical problem id such as P-1.",
        { problem_id: "P-1" },
      );
    }
    let bodyValue: unknown;
    try {
      bodyValue = parseAuthenticatedJsonBytes(authenticated.rawBody);
    } catch {
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Malformed JSON body",
          detail: "The external expert review request body must be valid JSON.",
          fixHint: "Send an ExternalExpertReviewCreateRequest JSON object.",
          rule: "A5",
          extensions: {
            schema: PROBLEMS_SCHEMA_URL,
            example: {
              claim_id: "C-1",
              claim_version: 1,
              verdict: "supports-resolution",
            },
          },
        }),
      );
    }
    const result = await recordExternalExpertReview(
      options.db,
      problemId,
      authenticated.principal.operatorId,
      bodyValue,
    );
    if (!result.ok) {
      return privateResponse(
        validatedProblem({
          status: result.status,
          code: result.code,
          title: "Cannot record external expert review",
          detail: result.detail,
          fixHint:
            result.code === "SECRET_SHAPED_CONTENT"
              ? "Remove credential-shaped strings from all external expert review fields and retry."
              : "Supply an existing published problem_id, active canonical claim_id@claim_version, reviewer attribution, attestation URI/SHA-256, verdict, and exact no_claim_boundary.",
          rule: result.code === "SECRET_SHAPED_CONTENT" ? "P7" : "A5",
          extensions: {
            schema: PROBLEMS_SCHEMA_URL,
            example: {
              claim_id: "C-1",
              claim_version: 1,
              verdict: "supports-resolution",
            },
          },
        }),
      );
    }
    return privateResponse(c.json(result.record, 201));
  });

  return app;
}
