import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  HYPOTHESES_SCHEMA_ID,
  HypothesesQuerySchema,
  HypothesisItemQuerySchema,
  PublicHypothesisIdSchema,
} from "@asimposium/contracts/hypotheses";
import { renderHypothesesHtml, renderHypothesesMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { hypothesisResponse } from "./hypotheses-face";
import { HypothesisReadError } from "./hypotheses-read";
import { loadPublicHypotheses, loadPublicHypothesisItem } from "./hypotheses-service";
import { createProofGapRoutes } from "./proof-gaps-router";

function refusal(kind: "query" | "missing" | "unavailable", method: string): Response {
  const response =
    kind === "query"
      ? validatedProblem({
          status: 400,
          code: "CURSOR_INVALID",
          title: "Invalid hypothesis read query",
          detail:
            "Use one canonical nonnegative through cursor. Lists also accept one after admission sequence; exact items do not. after cannot exceed through; future cursors are refused.",
          fixHint:
            "Follow the next link unchanged, or omit both parameters to start a current snapshot.",
          rule: "A5",
          extensions: {
            schema: HYPOTHESES_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-DEMO/hypotheses/H-1.json?through=10" },
          },
          headers: { "cache-control": "private, no-store" },
        })
      : kind === "missing"
        ? validatedProblem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "Public problem not found",
            detail: "No public problem is available at this identifier.",
            fixHint: "Choose a public problem from /problems.json.",
            rule: "A5",
            extensions: {
              schema: `${HYPOTHESES_SCHEMA_ID}#/properties/response`,
              example: { method: "GET", path: "/problems.json" },
            },
            headers: { "cache-control": "private, no-store" },
          })
        : validatedProblem({
            status: 500,
            code: "INTERNAL_ERROR",
            title: "Hypothesis records are unavailable",
            detail:
              "The complete bounded hypothesis page could not be established. No continuation was advanced.",
            fixHint: "Retry the same request without advancing your saved cursor.",
            headers: { "cache-control": "private, no-store", "retry-after": "5" },
          });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

export function createHypothesesRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  // This public subrouter is mounted before the legacy /p wildcard in app.ts.
  app.route("/", createProofGapRoutes());
  // Markdown is the default render: an unsuffixed list or item spelling is
  // sent to its .md face instead of a 404 (AGENTS.md: the first GET works).
  app.on(["GET", "HEAD"], "/p/:id/hypotheses", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}.md${url.search}`, 308);
  });
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/hypotheses.${format}`, async (c) => {
      const problemId = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = HypothesesQuerySchema.safeParse(Object.fromEntries(params));
      if (
        !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
        !query.success ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)
      ) return refusal("query", c.req.method);
      try {
        const result = await loadPublicHypotheses(c.env.DB, problemId, query.data);
        if (result === null) return refusal("missing", c.req.method);
        const body = format === "json" ? JSON.stringify(result.face)
          : format === "html" ? renderHypothesesHtml(result.face) : renderHypothesesMarkdown(result.face);
        return await hypothesisResponse(c.req.raw, body, format, result.face, result.unlisted);
      } catch (error) {
        return refusal(error instanceof HypothesisReadError && error.code === "CURSOR_INVALID"
          ? "query" : "unavailable", c.req.method);
      }
    });
  }
  // Exact identity, optionally at a historical cut. Never scan unrelated pages
  // or report a false 404 merely because the ledger contains many admissions.
  app.on(["GET", "HEAD"], "/p/:id/hypotheses/:target", async (c) => {
    const problemId = c.req.param("id");
    if (PublicHypothesisIdSchema.safeParse(c.req.param("target")).success) {
      const url = new URL(c.req.url);
      return c.redirect(`${url.pathname}.md${url.search}`, 308);
    }
    const match = /^(.*)\.(json|md|html)$/.exec(c.req.param("target"));
    if (!match || !PublicHypothesisIdSchema.safeParse(match[1]).success ||
      !PublicLedgerProblemIdSchema.safeParse(problemId).success)
      return refusal("missing", c.req.method);
    const params = new URL(c.req.url).searchParams;
    const query = HypothesisItemQuerySchema.safeParse(Object.fromEntries(params));
    if (!query.success || [...params.keys()].some((key) => params.getAll(key).length !== 1))
      return refusal("query", c.req.method);
    const format = match[2] as "json" | "md" | "html";
    try {
      const result = await loadPublicHypothesisItem(c.env.DB, problemId, match[1] as string, query.data);
      if (result === null) return refusal("missing", c.req.method);
      const body = format === "json" ? JSON.stringify(result.face)
        : format === "html" ? renderHypothesesHtml(result.face) : renderHypothesesMarkdown(result.face);
      const response = await hypothesisResponse(c.req.raw, body, format, result.face, result.unlisted);
      const headers = new Headers(response.headers);
      headers.set("link", `</p/${encodeURIComponent(problemId)}/hypotheses/${encodeURIComponent(match[1] as string)}.${format}?through=${result.face.cursor}>; rel="canonical"`);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return refusal(error instanceof HypothesisReadError && error.code === "CURSOR_INVALID"
        ? "query" : "unavailable", c.req.method);
    }
  });
  return app;
}
