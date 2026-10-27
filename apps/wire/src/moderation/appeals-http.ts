import {
  SCREENING_APPEALS_SCHEMA_ID,
  ScreeningAppealDecisionSchema,
  ScreeningAppealIdSchema,
  ScreeningAppealRequestSchema,
  ScreeningCaseIdSchema,
} from "@asimposium/contracts/appeals";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseAuthenticatedJsonBytes } from "../auth/http";
import type { EnrollmentRouterOptions } from "../enrollment/router";
import { validatedProblem } from "../http/envelope";
import { scanFieldsForCredentials, secretShapedContentProblem } from "../screening/credential-scan";
import {
  decideScreeningAppeal,
  operatorScreeningAppeals,
  ScreeningAppealError,
  sponsorScreeningCases,
  submitScreeningAppeal,
} from "./appeals-store";

function privateResponse(response: Response) {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function invalid(detail: string) {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "The screening appeal does not match its contract",
      detail,
      fixHint:
        "Select a reviewed rejection from your current sponsor account. Supply a brief private explanation and retain the same Idempotency-Key when retrying.",
      rule: "A5",
      extensions: {
        schema: SCREENING_APPEALS_SCHEMA_ID,
        example: {
          case_id: `QC-${"0".repeat(26)}`,
          statement: "Please reconsider the stated mathematical scope of this exact candidate.",
        },
      },
    }),
  );
}
export function createScreeningAppealsApp(
  options: Pick<EnrollmentRouterOptions, "db" | "verifiedSponsor" | "verifiedOperator">,
) {
  const app = new Hono();
  const routes = [
    {
      method: "GET",
      path: "/v1/sponsors/screening-cases",
      action: "sponsor.screening-cases.list",
      operator: false,
    },
    {
      method: "GET",
      path: "/v1/sponsors/screening-cases/:caseId",
      action: "sponsor.screening-cases.read",
      operator: false,
    },
    {
      method: "POST",
      path: "/v1/sponsors/screening-appeals",
      action: "sponsor.screening-appeals.submit",
      operator: false,
    },
    {
      method: "GET",
      path: "/v1/operators/screening-appeals",
      action: "operator.screening-appeals.list",
      operator: true,
    },
    {
      method: "GET",
      path: "/v1/operators/screening-appeals/:appealId",
      action: "operator.screening-appeals.read",
      operator: true,
    },
    {
      method: "POST",
      path: "/v1/operators/screening-appeals/decision",
      action: "operator.screening-appeals.decide",
      operator: true,
    },
  ] as const;
  for (const route of routes)
    app.on(route.method, route.path, async (c) => {
      try {
        if (new URL(c.req.url).search) return invalid("This route accepts no query parameters.");
        const verify = route.operator ? options.verifiedOperator : options.verifiedSponsor;
        if (!verify || !options.db) throw new Error("APPEAL_UNAVAILABLE");
        const authenticated = await verify(c.req.raw, route.path, route.action);
        cancelUnconsumedRequestBody(c.req.raw);
        if (authenticated instanceof Response) return privateResponse(authenticated);
        const expected = route.operator ? "operator" : "sponsor";
        if (
          authenticated.principal.type !== expected ||
          !(authenticated.rawBody instanceof Uint8Array)
        )
          return privateResponse(
            validatedProblem({
              status: 403,
              code: "WRONG_PRINCIPAL",
              title: "A human principal is required",
              detail: "Use the authenticated sponsor or operator console.",
              fixHint: "A Fellow credential cannot submit or decide a human appeal.",
            }),
          );
        const principalId =
          authenticated.principal.type === "operator"
            ? authenticated.principal.operatorId
            : authenticated.principal.type === "sponsor"
              ? authenticated.principal.sponsorId
              : "";
        if (route.method === "GET") {
          const caseId = c.req.param("caseId"),
            appealId = c.req.param("appealId");
          if (
            (caseId && !ScreeningCaseIdSchema.safeParse(caseId).success) ||
            (appealId && !ScreeningAppealIdSchema.safeParse(appealId).success)
          )
            return invalid("Use a valid case or appeal identifier.");
          return privateResponse(
            Response.json(
              route.operator
                ? await operatorScreeningAppeals(options.db, appealId)
                : await sponsorScreeningCases(options.db, principalId, caseId),
            ),
          );
        }
        if (c.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
          return invalid("Send an application/json request body.");
        let body: unknown;
        try {
          body = parseAuthenticatedJsonBytes(authenticated.rawBody);
        } catch {
          return invalid("The signed body is not valid JSON.");
        }
        const parsed = route.operator
          ? ScreeningAppealDecisionSchema.safeParse(body)
          : ScreeningAppealRequestSchema.safeParse(body);
        if (!parsed.success)
          return invalid("The signed body has missing, invalid or unsupported fields.");
        const text = "statement" in parsed.data ? parsed.data.statement : parsed.data.reason;
        const secrets = scanFieldsForCredentials({ statement: text });
        if (secrets.length) return privateResponse(secretShapedContentProblem(secrets));
        const key = c.req.header("idempotency-key");
        if (!key) return invalid("An Idempotency-Key is required.");
        return privateResponse(
          Response.json(
            "statement" in parsed.data
              ? await submitScreeningAppeal(options.db, principalId, parsed.data, key)
              : await decideScreeningAppeal(options.db, principalId, parsed.data, key),
          ),
        );
      } catch (error) {
        if (error instanceof ScreeningAppealError)
          return privateResponse(
            validatedProblem({
              status:
                error.code === "NOT_FOUND"
                  ? 404
                  : error.code === "STEP_UP" || error.code === "REVIEWER"
                    ? 403
                    : 409,
              code:
                error.code === "NOT_FOUND"
                  ? "MODERATION_TARGET_NOT_FOUND"
                  : error.code === "STEP_UP"
                    ? "STEP_UP_REQUIRED"
                    : "MODERATION_STATE_CONFLICT",
              title: "The screening appeal could not be applied",
              detail:
                error.code === "REVIEWER"
                  ? "The appeal requires a different operator who is not the affected sponsor."
                  : error.code === "STEP_UP"
                    ? "The operator must authenticate again before deciding this appeal."
                    : "The reviewed case, current ownership or retained command does not match this request.",
              fixHint:
                "Reload the review record. Retry an accepted command using its exact intent and original key; no content is published by an appeal.",
              ...(error.code === "STEP_UP"
                ? {}
                : {
                    rule: "A5",
                    extensions: {
                      schema: SCREENING_APPEALS_SCHEMA_ID,
                      example: {
                        case_id: `QC-${"0".repeat(26)}`,
                        statement:
                          "Please reconsider the precise mathematical scope of this held candidate.",
                      },
                    },
                  }),
            }),
          );
        return privateResponse(
          validatedProblem({
            status: 503,
            code: "OPERATOR_CONTROL_UNAVAILABLE",
            title: "Screening appeals are temporarily unavailable",
            detail: "The private review state could not be read or committed safely.",
            fixHint:
              "Retry the exact request with its retained key. Reload the case list to check whether a prior attempt succeeded.",
          }),
        );
      } finally {
        cancelUnconsumedRequestBody(c.req.raw);
      }
    });
  return app;
}
