import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  STATEMENTS_SCHEMA_ID,
  StatementHistoryQuerySchema,
  StatementVersionQuerySchema,
  StatementVersionSelectorSchema,
  statementHistoryPath,
  statementVersionPath,
} from "@asimposium/contracts/statements";
import { renderProjection } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { statementFaceResponse, statementsProjection } from "./statements-face.ts";
import {
  loadStatementHistory,
  loadStatementVersion,
  StatementReadError,
} from "./statements-read.ts";

function refusal(kind: StatementReadError["code"], method: string): Response {
  const response = validatedProblem(
    kind === "query"
      ? {
          status: 400,
          code: "CURSOR_INVALID",
          title: "Choose an exact published statement or history cursor",
          detail:
            "Version must be a canonical positive safe integer. through and after must be canonical nonnegative safe integers at or before the current public cursor. Unknown and repeated parameters are refused.",
          fixHint:
            "Follow the history continuation unchanged, or choose one exact statement version.",
          rule: "A5",
          extensions: {
            schema: STATEMENTS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-DEMO/statements/2.json?through=10" },
          },
          headers: { "cache-control": "private, no-store" },
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "Published statement unavailable",
            detail:
              "No readable published statement or public problem matches this request. Private drafts and withdrawn publications are unavailable.",
            fixHint:
              "Choose a readable problem and a version listed in its public statement history.",
            rule: "A5",
            extensions: {
              schema: STATEMENTS_SCHEMA_ID,
              example: { method: "GET", path: "/p/P-DEMO/statements.json" },
            },
            headers: { "cache-control": "private, no-store" },
          }
        : {
            status: 500,
            code: "INTERNAL_ERROR",
            title: "Statement history is unavailable",
            detail:
              "The bounded immutable publication history could not be established. This is not an empty statement history.",
            fixHint: "Retry the unchanged request without advancing your saved cursor.",
            headers: { "cache-control": "private, no-store", "retry-after": "5" },
          },
  );
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
function repeated(params: URLSearchParams): boolean {
  return [...params.keys()].some((key) => params.getAll(key).length !== 1);
}

/** The previously advertised alias must never return today's digest. Keep the
 * exact version and optional cut while redirecting to its truthful resource. */
export function legacyStatementRedirect(
  request: Request,
  problem: string,
  format: "json" | "md",
): Response | undefined {
  const params = new URL(request.url).searchParams;
  if (!params.has("statement")) return undefined;
  const version = StatementVersionSelectorSchema.safeParse(params.get("statement"));
  const ambiguous = repeated(params);
  params.delete("statement");
  const query = StatementVersionQuerySchema.safeParse(Object.fromEntries(params));
  if (
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !version.success ||
    !query.success ||
    ambiguous
  )
    return refusal("query", request.method);
  return new Response(null, {
    status: 308,
    headers: {
      location: statementVersionPath(problem, version.data, format, query.data),
      "cache-control": "private, no-store",
    },
  });
}

export function createStatementRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/statements.${format}`, async (c) => {
      const problem = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = StatementHistoryQuerySchema.safeParse(Object.fromEntries(params));
      if (
        !PublicLedgerProblemIdSchema.safeParse(problem).success ||
        !query.success ||
        repeated(params)
      )
        return refusal("query", c.req.method);
      try {
        const result = await loadStatementHistory(c.env.DB, problem, query.data);
        const body =
          format === "json"
            ? JSON.stringify(result.face)
            : renderProjection(
                statementsProjection(result.face),
                format === "md" ? "md" : "html-fragment",
              ).body;
        return await statementFaceResponse(c.req.raw, body, format, result.face, result.unlisted);
      } catch (error) {
        return refusal(
          error instanceof StatementReadError ? error.code : "unavailable",
          c.req.method,
        );
      }
    });
  }
  app.on(["GET", "HEAD"], "/p/:id/statements/:reference", async (c) => {
    const problem = c.req.param("id");
    const reference = c.req.param("reference");
    const match = /^([^.]+)\.(json|md|html)$(?![\s\S])/.exec(reference);
    const version = StatementVersionSelectorSchema.safeParse(match?.[1] ?? reference);
    const params = new URL(c.req.url).searchParams;
    const query = StatementVersionQuerySchema.safeParse(Object.fromEntries(params));
    if (
      !PublicLedgerProblemIdSchema.safeParse(problem).success ||
      !version.success ||
      !query.success ||
      repeated(params)
    )
      return refusal("query", c.req.method);
    if (!match)
      return c.redirect(statementVersionPath(problem, version.data, "md", query.data), 308);
    const format = match[2] as "json" | "md" | "html";
    try {
      const result = await loadStatementVersion(c.env.DB, problem, version.data, query.data);
      const body =
        format === "json"
          ? JSON.stringify(result.face)
          : renderProjection(
              statementsProjection(result.face),
              format === "md" ? "md" : "html-fragment",
            ).body;
      return await statementFaceResponse(c.req.raw, body, format, result.face, result.unlisted);
    } catch (error) {
      return refusal(
        error instanceof StatementReadError ? error.code : "unavailable",
        c.req.method,
      );
    }
  });
  app.on(["GET", "HEAD"], "/p/:id/statements", (c) => {
    const params = new URL(c.req.url).searchParams;
    const query = StatementHistoryQuerySchema.safeParse(Object.fromEntries(params));
    if (
      !PublicLedgerProblemIdSchema.safeParse(c.req.param("id")).success ||
      !query.success ||
      repeated(params)
    )
      return refusal("query", c.req.method);
    return c.redirect(statementHistoryPath(c.req.param("id"), "md", query.data), 308);
  });
  return app;
}
