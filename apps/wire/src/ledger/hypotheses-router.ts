import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import { HYPOTHESES_SCHEMA_ID, HypothesesQuerySchema } from "@asimposium/contracts/hypotheses";
import { renderHypothesesHtml, renderHypothesesMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { hypothesisResponse } from "./hypotheses-face";
import { HypothesisReadError } from "./hypotheses-read";
import { loadPublicHypotheses } from "./hypotheses-service";

function refusal(kind: "query" | "missing" | "unavailable", method: string): Response {
  const response = kind === "query" ? validatedProblem({
    status: 400, code: "CURSOR_INVALID", title: "Invalid hypothesis read query",
    detail: "Use at most one canonical nonnegative through cursor and one after admission sequence. after cannot exceed through; future cursors are refused.",
    fixHint: "Follow the next link unchanged, or omit both parameters to start a current snapshot.",
    rule: "A5", extensions: { schema: `${HYPOTHESES_SCHEMA_ID}#/properties/query`,
      example: { method: "GET", path: "/p/P-DEMO/hypotheses.json" } },
    headers: { "cache-control": "private, no-store" },
  }) : kind === "missing" ? validatedProblem({
    status: 404, code: "PROBLEM_NOT_FOUND", title: "Public problem not found",
    detail: "No public problem is available at this identifier.",
    fixHint: "Choose a public problem from /problems.json.", headers: { "cache-control": "private, no-store" },
  }) : validatedProblem({
    status: 500, code: "INTERNAL_ERROR", title: "Hypothesis records are unavailable",
    detail: "The complete bounded hypothesis page could not be established. No continuation was advanced.",
    fixHint: "Retry the same request without advancing your saved cursor.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
  return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export function createHypothesesRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/hypotheses.${format}`, async c => {
      const problemId = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = HypothesesQuerySchema.safeParse(Object.fromEntries(params));
      if (!PublicLedgerProblemIdSchema.safeParse(problemId).success || !query.success ||
          [...params.keys()].some(key => params.getAll(key).length !== 1)) return refusal("query", c.req.method);
      try {
        const result = await loadPublicHypotheses(c.env.DB, problemId, query.data);
        if (result === null) return refusal("missing", c.req.method);
        const body = format === "json" ? JSON.stringify(result.face) :
          format === "html" ? renderHypothesesHtml(result.face) : renderHypothesesMarkdown(result.face);
        return await hypothesisResponse(c.req.raw, body, format, result.face, result.unlisted);
      } catch (error) {
        return refusal(error instanceof HypothesisReadError && error.code === "CURSOR_INVALID" ? "query" : "unavailable", c.req.method);
      }
    });
  }
  return app;
}
