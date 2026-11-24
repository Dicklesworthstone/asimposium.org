import {
  RESEARCH_LISTS_SCHEMA_ID,
  ResearchListQuerySchema,
  reviewsListPath,
} from "@asimposium/contracts/research-lists";
import { renderReviewListHtml, renderReviewListMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { loadReviewsList, ReviewsListReadError } from "./reviews-list-read.ts";

function refusal(kind: "query" | "not-found" | "unavailable", method: string): Response {
  const response =
    kind === "query"
      ? validatedProblem({
          status: 400,
          code: "CURSOR_INVALID",
          title: "Invalid completed review collection query",
          detail:
            "Use one canonical nonnegative through cursor and optional after sequence. after requires through and cannot exceed it. Unknown parameters and future cursors are refused.",
          fixHint: "Follow the next link unchanged, or omit both parameters to start a current page.",
          rule: "A5",
          extensions: {
            schema: RESEARCH_LISTS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-DEMO/reviews.json?through=10&after=0" },
          },
          headers: { "cache-control": "private, no-store" },
        })
      : kind === "not-found"
        ? validatedProblem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "Public problem not found",
            detail: "No public problem is available at this identifier.",
            fixHint: "Choose a public problem from /problems.json.",
            rule: "A5",
            extensions: {
              schema: RESEARCH_LISTS_SCHEMA_ID,
              example: { method: "GET", path: "/problems.json" },
            },
            headers: { "cache-control": "private, no-store" },
          })
        : validatedProblem({
            status: 503,
            code: "INTERNAL_ERROR",
            title: "Completed reviews are unavailable",
            detail: "The bounded review page could not be established with current visibility.",
            fixHint: "Retry the same request without advancing your saved cursor.",
            headers: { "cache-control": "private, no-store", "retry-after": "5" },
          });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

export function createReviewListRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.on(["GET", "HEAD"], "/p/:id/reviews", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}.md${url.search}`, 308);
  });
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/reviews.${format}`, async (c) => {
      const problem = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = ResearchListQuerySchema.safeParse(Object.fromEntries(params));
      if (!query.success || [...params.keys()].some((key) => params.getAll(key).length !== 1))
        return refusal("query", c.req.method);
      try {
        const result = await loadReviewsList(c.env.DB, problem, query.data);
        const body =
          format === "json"
            ? JSON.stringify(result.face)
            : format === "html"
              ? renderReviewListHtml(result.face)
              : renderReviewListMarkdown(result.face);
        if (new TextEncoder().encode(body).length > 128 * 1024)
          throw new ReviewsListReadError("unavailable");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${format}\n${body}`),
        );
        const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
        const canonical = reviewsListPath(problem, format, {
          through: result.face.cursor,
          after: result.face.after,
        });
        const headers = new Headers({
          "content-type":
            format === "json"
              ? "application/json; charset=utf-8"
              : format === "md"
                ? "text/markdown; charset=utf-8"
                : "text/html; charset=utf-8",
          "cache-control": result.unlisted
            ? "private, no-store"
            : "public, max-age=0, must-revalidate",
          "content-location": canonical,
          "x-content-type-options": "nosniff",
          etag,
          link: `<${canonical}>; rel="canonical", <${RESEARCH_LISTS_SCHEMA_ID}>; rel="describedby"`,
        });
        if (result.face.next_after !== null)
          headers.append(
            "link",
            `<${reviewsListPath(problem, format, { through: result.face.cursor, after: result.face.next_after })}>; rel="next"`,
          );
        if (result.unlisted) headers.set("x-robots-tag", "noindex, nofollow");
        if (format === "html")
          headers.set(
            "content-security-policy",
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          );
        await result.assertCurrent();
        const matches = (c.req.header("if-none-match") ?? "")
          .split(",")
          .some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()));
        return new Response(matches || c.req.method === "HEAD" ? null : body, {
          status: matches ? 304 : 200,
          headers,
        });
      } catch (error) {
        return refusal(
          error instanceof ReviewsListReadError ? error.code : "unavailable",
          c.req.method,
        );
      }
    });
  }
  return app;
}
