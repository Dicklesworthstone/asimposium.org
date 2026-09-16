import { REVIEW_QUEUE_SCHEMA_ID, ReviewQueueQuerySchema } from "@asimposium/contracts/review-queue";
import { renderReviewQueueHtml, renderReviewQueueMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { reviewQueueResponse } from "./review-queue-http";
import { loadReviewQueue } from "./review-queue-service";

function refusal(kind: "query" | "unavailable", method: string): Response {
  const response = kind === "query" ? validatedProblem({
    status: 400, code: "CURSOR_INVALID", title: "Choose a valid review queue page",
    detail: "Use at most one problem identifier and one unchanged after cursor. No other query parameters are accepted.",
    fixHint: "Read /reviews.json, or preserve the selected problem and URL-encode next_after from the preceding page.",
    rule: "A5", extensions: {
      schema: `${REVIEW_QUEUE_SCHEMA_ID}#/properties/query`,
      example: { method: "GET", path: "/reviews.json?problem=P-DEMO" },
      next_actions: [{ method: "GET", url: "/reviews.json", why: "Restart public review discovery without advancing an invalid cursor." }],
    }, headers: { "cache-control": "private, no-store" },
  }) : validatedProblem({
    status: 500, code: "INTERNAL_ERROR", title: "Review discovery is temporarily unavailable",
    detail: "A complete review queue page could not be established. This is not an empty queue.",
    fixHint: "Retry the unchanged request; retain your existing continuation cursor.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
  return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export function createReviewQueueRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  // Explicit suffixes keep representation selection deterministic, even with a conflicting Accept header.
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/reviews.${format}`, async c => {
      const params = new URL(c.req.url).searchParams;
      const parsed = ReviewQueueQuerySchema.safeParse(Object.fromEntries(params));
      if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length > 1)) return refusal("query", c.req.method);
      try {
        const data = await loadReviewQueue(c.env.DB, parsed.data);
        const body = format === "json" ? JSON.stringify(data)
          : format === "md" ? renderReviewQueueMarkdown(data, parsed.data) : renderReviewQueueHtml(data, parsed.data);
        return await reviewQueueResponse(c.req.raw, body, format);
      } catch {
        // Never reflect/log SQL, private identifiers, scientific bodies or driver errors.
        return refusal("unavailable", c.req.method);
      }
    });
  }
  app.on(["GET", "HEAD"], "/reviews", c => {
    // Markdown is the canonical agent entry. Preserve the query; its schema is checked at the destination.
    const query = new URL(c.req.url).search;
    return c.redirect(`/reviews.md${query}`, 308);
  });
  return app;
}
