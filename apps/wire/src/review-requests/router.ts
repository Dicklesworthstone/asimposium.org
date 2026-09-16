import { ProblemIdSchema } from "@asimposium/contracts";
import {
  CreateReviewRequestSchema,
  REVIEW_REQUESTS_SCHEMA_ID,
  RespondReviewRequestSchema,
  ReviewRequestIdSchema,
  ReviewRequestReceiptSchema,
  ReviewRequestsQuerySchema,
  ReviewRequestsResponseSchema,
} from "@asimposium/contracts/review-requests";
import { type Context, Hono } from "hono";
import { readBoundedRequestBody } from "../auth/http.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { REVIEW_REQUEST_PAGE_SIZE, ReviewRequestError } from "./model.ts";
import { createReviewRequest, respondReviewRequest, reviewRequestView } from "./service.ts";
import { listRequests, REQUEST_NOTICE, type ReplayProtector, readRequest } from "./store.ts";

type WireContext = Context<{ Bindings: Env }>;
interface Options {
  service: EnrollmentService;
  replayProtector: ReplayProtector;
}
const PATH = "/v1/p/:problem/review-requests";
function refusal(
  code: "schema" | "auth" | "missing" | "conflict" | "replay" | "unavailable",
  method: string,
): Response {
  const contract = code === "schema";
  const response = validatedProblem({
    status: contract
      ? 400
      : code === "auth"
        ? 401
        : code === "missing"
          ? 404
          : code === "unavailable"
            ? 500
            : 409,
    code: contract
      ? "SCHEMA_INVALID"
      : code === "auth"
        ? "UNAUTHORIZED"
        : code === "missing"
          ? "PROBLEM_NOT_FOUND"
          : code === "replay"
            ? "IDEMPOTENCY_CONFLICT"
            : code === "unavailable"
              ? "INTERNAL_ERROR"
              : "OBJECT_VERSION_CONFLICT",
    title: "Review invitation request was not accepted",
    detail: contract
      ? "Use the strict JSON contract and one Idempotency-Key on writes. Read queries accept only one opaque after request ID from your preceding page."
      : code === "auth"
        ? "An active authorization for this operation was not established."
        : code === "missing"
          ? "No accessible review invitation resource exists here."
          : code === "unavailable"
            ? "The review invitation operation is temporarily unavailable. No successful change is claimed."
            : "The request conflicts with a recorded decision, target version, eligibility, capacity, or replay key.",
    fixHint: contract
      ? "Read /schemas/review-requests.v1.json. Do not send scientific status or reviewer-tier fields."
      : code === "auth"
        ? "Use an active sponsor-approved credential with the required scope and problem membership."
        : code === "unavailable"
          ? "Retry the unchanged write with the same Idempotency-Key."
          : "Refresh your invitation list. Respond using the current version, and never change a request under its existing Idempotency-Key.",
    ...(contract
      ? {
          rule: "A5" as const,
          extensions: {
            schema: REVIEW_REQUESTS_SCHEMA_ID,
            example: { action: "accept", expected_version: 1 },
          },
        }
      : {}),
    headers: {
      "cache-control": "private, no-store",
      ...(code === "unavailable" ? { "retry-after": "5" } : {}),
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
function respond(c: WireContext, value: unknown, status = 200): Response {
  return new Response(c.req.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
export function createReviewRequestRouter(options: Options): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  async function identity(c: WireContext): Promise<FellowCredentialBinding | Response> {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const binding =
      token === undefined ? undefined : await options.service.credentialBinding(token);
    if (!binding) return refusal("auth", c.req.method);
    const problem = c.req.param("problem") ?? "";
    if (
      !ProblemIdSchema.safeParse(problem).success ||
      (binding.grantedResources.problemBinding !== undefined &&
        binding.grantedResources.problemBinding !== problem)
    ) {
      return refusal("missing", c.req.method);
    }
    const exists = await c.env.DB.prepare(
      "SELECT id FROM problems WHERE id = ? AND status <> 'private-draft' AND unlisted = 0",
    )
      .bind(problem)
      .first();
    return exists ? binding : refusal("missing", c.req.method);
  }
  async function handle(
    c: WireContext,
    operation: "list" | "get" | "create" | "respond",
  ): Promise<Response> {
    try {
      const auth = await identity(c);
      if (auth instanceof Response) return auth;
      const problem = c.req.param("problem") ?? "";
      const id = c.req.param("requestId");
      if (id !== undefined && !ReviewRequestIdSchema.safeParse(id).success)
        return refusal("missing", c.req.method);
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return refusal("schema", c.req.method);
      if (operation === "get") {
        if (params.size !== 0 || id === undefined)
          return refusal(id === undefined ? "missing" : "schema", c.req.method);
        const row = await readRequest(c.env.DB, problem, auth.fellowId, id);
        return row
          ? respond(c, await reviewRequestView(row, Date.now()))
          : refusal("missing", c.req.method);
      }
      if (operation === "list") {
        const query = ReviewRequestsQuerySchema.safeParse(Object.fromEntries(params));
        if (!query.success) return refusal("schema", c.req.method);
        const rows = await listRequests(c.env.DB, problem, auth.fellowId, query.data.after);
        const page = rows.slice(0, REVIEW_REQUEST_PAGE_SIZE);
        const now = Date.now();
        return respond(
          c,
          ReviewRequestsResponseSchema.parse({
            schema: REVIEW_REQUESTS_SCHEMA_ID,
            problem_id: problem,
            requests: await Promise.all(page.map((row) => reviewRequestView(row, now))),
            next_after:
              rows.length > REVIEW_REQUEST_PAGE_SIZE ? (page.at(-1)?.request_id ?? null) : null,
            omitted: rows.length > REVIEW_REQUEST_PAGE_SIZE ? ["page_limit"] : [],
            notice: REQUEST_NOTICE,
          }),
        );
      }
      const key = c.req.header("idempotency-key");
      if (
        params.size !== 0 ||
        !key ||
        !/^[A-Za-z0-9._-]{1,160}$/.test(key) ||
        !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
      )
        return refusal("schema", c.req.method);
      const body = await readBoundedRequestBody(c.req.raw, 16384);
      if (!body.ok) return refusal("schema", c.req.method);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
      } catch {
        return refusal("schema", c.req.method);
      }
      if (operation === "create") {
        const parsed = CreateReviewRequestSchema.safeParse(value);
        if (!parsed.success) return refusal("schema", c.req.method);
        const result = await createReviewRequest(
          c.env.DB,
          options.replayProtector,
          auth,
          problem,
          parsed.data,
          key,
        );
        return respond(c, ReviewRequestReceiptSchema.parse(result), 201);
      }
      if (id === undefined) return refusal("missing", c.req.method);
      const parsed = RespondReviewRequestSchema.safeParse(value);
      if (!parsed.success) return refusal("schema", c.req.method);
      const result = await respondReviewRequest(
        c.env.DB,
        options.replayProtector,
        auth,
        problem,
        id,
        parsed.data,
        key,
      );
      return respond(c, ReviewRequestReceiptSchema.parse(result));
    } catch (error) {
      const code = error instanceof ReviewRequestError ? error.code : "UNAVAILABLE";
      return refusal(
        code === "NOT_FOUND"
          ? "missing"
          : code === "INELIGIBLE"
            ? "auth"
            : code === "IDEMPOTENCY_CONFLICT"
              ? "replay"
              : code === "CONFLICT" || code === "LIMIT"
                ? "conflict"
                : "unavailable",
        c.req.method,
      );
    }
  }
  app.on(["GET", "HEAD"], PATH, (c) => handle(c, "list"));
  app.on(["GET", "HEAD"], `${PATH}/:requestId`, (c) => handle(c, "get"));
  app.post(PATH, (c) => handle(c, "create"));
  app.post(`${PATH}/:requestId/respond`, (c) => handle(c, "respond"));
  return app;
}
