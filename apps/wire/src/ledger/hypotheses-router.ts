import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  HYPOTHESES_SCHEMA_ID,
  HypothesesQuerySchema,
  HypothesesResponseSchema,
} from "@asimposium/contracts/hypotheses";
import { renderHypothesesHtml, renderHypothesesMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { hypothesisResponse } from "./hypotheses-face";
import { HypothesisReadError } from "./hypotheses-read";
import { loadPublicHypotheses } from "./hypotheses-service";
import { createProofGapRoutes } from "./proof-gaps-router";

function refusal(kind: "query" | "missing" | "unavailable", method: string): Response {
  const response =
    kind === "query"
      ? validatedProblem({
          status: 400,
          code: "CURSOR_INVALID",
          title: "Invalid hypothesis read query",
          detail:
            "Use at most one canonical nonnegative through cursor and one after admission sequence. after cannot exceed through; future cursors are refused.",
          fixHint:
            "Follow the next link unchanged, or omit both parameters to start a current snapshot.",
          rule: "A5",
          extensions: {
            schema: `${HYPOTHESES_SCHEMA_ID}#/properties/query`,
            example: { method: "GET", path: "/p/P-DEMO/hypotheses.json" },
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
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/hypotheses.${format}`, async (c) => {
      const problemId = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = HypothesesQuerySchema.safeParse(Object.fromEntries(params));
      if (
        !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
        !query.success ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)
      )
        return refusal("query", c.req.method);
      try {
        const result = await loadPublicHypotheses(c.env.DB, problemId, query.data);
        if (result === null) return refusal("missing", c.req.method);
        const body =
          format === "json"
            ? JSON.stringify(result.face)
            : format === "html"
              ? renderHypothesesHtml(result.face)
              : renderHypothesesMarkdown(result.face);
        return await hypothesisResponse(c.req.raw, body, format, result.face, result.unlisted);
      } catch (error) {
        return refusal(
          error instanceof HypothesisReadError && error.code === "CURSOR_INVALID"
            ? "query"
            : "unavailable",
          c.req.method,
        );
      }
    });
  }
  // Item face (bead asimposiumorg-qvzk): the same face as the list, holding
  // only the one hypothesis, rendered by the same renderer at one pinned
  // snapshot cursor, so the item agrees byte-for-byte with its list entry.
  app.on(["GET", "HEAD"], "/p/:id/hypotheses/:target", async (c) => {
    const problemId = c.req.param("id");
    const match = /^(H-[0-9A-HJKMNP-TV-Z]{1,78})\.(json|md|html)$/.exec(c.req.param("target"));
    if (!match || !PublicLedgerProblemIdSchema.safeParse(problemId).success)
      return refusal("missing", c.req.method);
    if (new URL(c.req.url).search !== "") return refusal("query", c.req.method);
    const hypothesisId = match[1] as string;
    const format = match[2] as "json" | "md" | "html";
    try {
      let page = await loadPublicHypotheses(c.env.DB, problemId, {});
      if (page === null) return refusal("missing", c.req.method);
      const through = String(page.face.cursor);
      for (let pages = 0; pages < 256; pages++) {
        const item = page.face.hypotheses.find((h) => h.hypothesis_id === hypothesisId);
        if (item !== undefined) {
          const face = HypothesesResponseSchema.parse({
            ...page.face,
            hypotheses: [item],
            // An item face is not paged: no continuation, so no page_limit.
            next_after: null,
            omitted: page.face.omitted.filter((reason) => reason !== "page_limit"),
          });
          const body =
            format === "json"
              ? JSON.stringify(face)
              : format === "html"
                ? renderHypothesesHtml(face)
                : renderHypothesesMarkdown(face);
          return await hypothesisResponse(c.req.raw, body, format, face, page.unlisted);
        }
        if (page.face.next_after === null) break;
        const next = await loadPublicHypotheses(c.env.DB, problemId, {
          through,
          after: String(page.face.next_after),
        });
        if (next === null) break;
        page = next;
      }
      return refusal("missing", c.req.method);
    } catch (error) {
      return refusal(
        error instanceof HypothesisReadError && error.code === "CURSOR_INVALID"
          ? "query"
          : "unavailable",
        c.req.method,
      );
    }
  });
  return app;
}
