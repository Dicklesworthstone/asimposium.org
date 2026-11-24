import {
  INTEGRITY_CASES_SCHEMA_ID,
  INTEGRITY_CASE_MAX_RESPONSE_BYTES,
  IntegrityCaseOpenRequestSchema,
  IntegrityCaseQuerySchema,
  IntegrityCaseReadRequestSchema,
  IntegrityCaseResolveRequestSchema,
  IntegrityCaseRespondRequestSchema,
} from "@asimposium/contracts/integrity-cases";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseAuthenticatedJsonBytes } from "../auth/http.ts";
import type { EnrollmentRouterOptions } from "../enrollment/router.ts";
import { validatedProblem } from "../http/envelope.ts";
import { scanFieldsForCredentials, secretShapedContentProblem } from "../screening/credential-scan.ts";
import { queryIntegrityCases, readIntegrityCase } from "./integrity-read.ts";
import {
  IntegrityCaseError,
  openIntegrityCase,
  resolveIntegrityCase,
  respondToIntegrityCase,
} from "./integrity-store.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const EXAMPLE = {
  case_id: `IC-${"0".repeat(26)}`,
  after_revision: 0,
  limit: 20,
};

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function invalid(detail: string): Response {
  return privateResponse(validatedProblem({
    status: 422, code: "SCHEMA_INVALID",
    title: "The integrity review request does not match its contract",
    detail,
    fixHint: "Use the signed human console, the exact case revision and the documented JSON fields. Keep the original Idempotency-Key when retrying an uncertain write.",
    rule: "A5", extensions: { schema: INTEGRITY_CASES_SCHEMA_ID, example: EXAMPLE },
  }));
}
function json(value: unknown): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > INTEGRITY_CASE_MAX_RESPONSE_BYTES)
    throw new Error("INTEGRITY_RESPONSE_TOO_LARGE");
  return privateResponse(new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}
function refusal(error: IntegrityCaseError): Response {
  if (error.code === "STEP_UP")
    return privateResponse(validatedProblem({
      status: 403, code: "STEP_UP_REQUIRED",
      title: "Recent operator authentication is required",
      detail: "Opening or deciding an integrity investigation requires operator authentication within the last fifteen minutes.",
      fixHint: "Authenticate again through the operator console. Keep the original key and decision intent when retrying.",
    }));
  const status = error.code === "NOT_FOUND" || error.code === "SOURCE_UNAVAILABLE" ? 404 :
    error.code === "REVIEWER" ? 403 : 409;
  const code = error.code === "NOT_FOUND" ? "MODERATION_TARGET_NOT_FOUND" :
    error.code === "SOURCE_UNAVAILABLE" ? "REPORT_TARGET_NOT_FOUND" :
      error.code === "REVIEWER" ? "WRITE_REFUSED" :
        error.code === "IDEMPOTENCY" ? "IDEMPOTENCY_CONFLICT" : "OBJECT_VERSION_CONFLICT";
  const detail = error.code === "REVIEWER"
    ? "A known relationship to the subject, reporter or a correction's author prevents this operator decision. An appeal also requires a different operator from the original resolver."
    : error.code === "SOURCE_UNAVAILABLE"
      ? "The exact reported publication or a correction source could not be verified. Nothing was changed."
      : error.code === "NOT_FOUND"
        ? "No case or eligible integrity report is available to this principal."
        : error.code === "IDEMPOTENCY"
          ? "This key already identifies a different integrity command."
          : "The case revision, report eligibility or allowed lifecycle changed. A resolved case permits one sponsor appeal; its second outcome is final within this workflow.";
  return privateResponse(validatedProblem({
    status, code, title: "The integrity review request could not be applied", detail,
    fixHint: error.code === "REVIEWER"
      ? "Have an eligible independent operator review the case. A conflict declaration cannot override a recorded relationship."
      : "Reload the private case or report. Use the current revision for a new action, or retain the exact intent and key when retrying the original action. Claim correction references must include @version.",
    rule: "A5", extensions: { schema: INTEGRITY_CASES_SCHEMA_ID, example: EXAMPLE },
  }));
}

export function createIntegrityCaseRouter(
  options: Pick<EnrollmentRouterOptions, "db" | "verifiedSponsor" | "verifiedOperator">,
) {
  const app = new Hono();
  const routes = [
    { path: "/v1/operators/integrity/cases/query", action: "operator.integrity.cases.query", operator: true, kind: "query", schema: IntegrityCaseQuerySchema },
    { path: "/v1/operators/integrity/cases/read", action: "operator.integrity.cases.read", operator: true, kind: "read", schema: IntegrityCaseReadRequestSchema },
    { path: "/v1/operators/integrity/cases/open", action: "operator.integrity.cases.open", operator: true, kind: "open", schema: IntegrityCaseOpenRequestSchema },
    { path: "/v1/operators/integrity/cases/resolve", action: "operator.integrity.cases.resolve", operator: true, kind: "resolve", schema: IntegrityCaseResolveRequestSchema },
    { path: "/v1/sponsors/integrity/cases/query", action: "sponsor.integrity.cases.query", operator: false, kind: "query", schema: IntegrityCaseQuerySchema },
    { path: "/v1/sponsors/integrity/cases/read", action: "sponsor.integrity.cases.read", operator: false, kind: "read", schema: IntegrityCaseReadRequestSchema },
    { path: "/v1/sponsors/integrity/cases/respond", action: "sponsor.integrity.cases.respond", operator: false, kind: "respond", schema: IntegrityCaseRespondRequestSchema },
  ] as const;
  for (const route of routes) {
    app.post(route.path, async (c) => {
      try {
        if (new URL(c.req.url).search) return invalid("This route accepts no query parameters.");
        const verify = route.operator ? options.verifiedOperator : options.verifiedSponsor;
        if (!verify || !options.db) throw new Error("INTEGRITY_UNAVAILABLE");
        const authenticated = await verify(c.req.raw, route.path, route.action);
        cancelUnconsumedRequestBody(c.req.raw);
        if (authenticated instanceof Response) return privateResponse(authenticated);
        if (authenticated.principal.type !== (route.operator ? "operator" : "sponsor") ||
          !(authenticated.rawBody instanceof Uint8Array))
          return privateResponse(validatedProblem({
            status: 403, code: "WRONG_PRINCIPAL",
            title: "A human principal is required",
            detail: "An integrity response or investigation must come through the authenticated sponsor or operator console.",
            fixHint: "A Fellow bearer token cannot submit, read or decide a restricted human investigation.",
          }));
        const principalId = authenticated.principal.type === "operator"
          ? authenticated.principal.operatorId
          : authenticated.principal.type === "sponsor" ? authenticated.principal.sponsorId : "";
        if (authenticated.rawBody.byteLength > MAX_REQUEST_BYTES)
          return invalid("The signed JSON body exceeds the bounded integrity request size.");
        if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          return invalid("Send application/json.");
        let body: unknown;
        try {
          body = parseAuthenticatedJsonBytes(authenticated.rawBody);
        } catch {
          return invalid("The signed body is not valid JSON.");
        }
        const parsed = route.schema.safeParse(body);
        if (!parsed.success) return invalid("The signed body has missing, invalid or unsupported fields.");
        if (route.kind === "query")
          return json(await queryIntegrityCases(
            options.db, IntegrityCaseQuerySchema.parse(parsed.data),
            route.operator ? undefined : principalId,
          ));
        if (route.kind === "read")
          return json(await readIntegrityCase(
            options.db, IntegrityCaseReadRequestSchema.parse(parsed.data),
            route.operator ? undefined : principalId,
          ));
        const key = c.req.header("idempotency-key");
        if (!key || !/^[A-Za-z0-9._-]{1,160}$/.test(key))
          return invalid("A nonempty Idempotency-Key of at most 160 safe ASCII characters is required.");
        const fields = route.kind === "open"
          ? { summary: IntegrityCaseOpenRequestSchema.parse(parsed.data).summary }
          : route.kind === "respond"
            ? { response: IntegrityCaseRespondRequestSchema.parse(parsed.data).response }
            : { rationale: IntegrityCaseResolveRequestSchema.parse(parsed.data).rationale };
        const secrets = scanFieldsForCredentials(fields);
        if (secrets.length) return privateResponse(secretShapedContentProblem(secrets));
        if (route.kind === "open")
          return json(await openIntegrityCase(
            options.db, principalId, IntegrityCaseOpenRequestSchema.parse(parsed.data), key,
          ));
        if (route.kind === "respond")
          return json(await respondToIntegrityCase(
            options.db, principalId, IntegrityCaseRespondRequestSchema.parse(parsed.data), key,
          ));
        return json(await resolveIntegrityCase(
          options.db, principalId, IntegrityCaseResolveRequestSchema.parse(parsed.data), key,
        ));
      } catch (error) {
        if (error instanceof IntegrityCaseError) return refusal(error);
        return privateResponse(validatedProblem({
          status: 503, code: "OPERATOR_CONTROL_UNAVAILABLE",
          title: "The integrity review service is temporarily unavailable",
          detail: "The restricted investigation state could not be read or committed reliably.",
          fixHint: "Retry the exact signed request with its original key. Reload the case to determine whether an earlier attempt succeeded.",
        }));
      } finally {
        cancelUnconsumedRequestBody(c.req.raw);
      }
    });
  }
  return app;
}
