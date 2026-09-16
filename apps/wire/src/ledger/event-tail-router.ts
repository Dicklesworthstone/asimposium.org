import {
  EVENT_TAIL_PROBLEM_PATTERN,
  EVENT_TAIL_SCHEMA_ID,
  EventTailQuerySchema,
  EventTailResponseSchema,
  parseEventTailQuery,
} from "@asimposium/contracts/event-tail";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { eventTailResponse } from "./event-tail-http";
import { EventTailReadError, readPublicEventTail } from "./event-tail-read";

function refusal(kind: "query" | "missing" | "unavailable", method: string): Response {
  const response = kind === "query" ? validatedProblem({
    status: 400, code: "CURSOR_INVALID", title: "Choose a valid problem event cursor",
    detail: "Use one canonical nonnegative since cursor, limit from 1 to 200, and an optional through cursor at or after since. Cursors cannot exceed the public problem head.",
    fixHint: "Follow page_end.next unchanged to finish a snapshot, then page_end.poll for newer events. Do not use the site-wide /cursor value here.",
    rule: "A5",
    extensions: { schema: `${EVENT_TAIL_SCHEMA_ID}#/properties/query`,
      example: { method: "GET", path: "/p/P-DEMO/events.ndjson?since=0&limit=50" },
      next_actions: [{ method: "GET", url: "/problems.json", why: "Find the public problem before resuming its event sequence." }] },
    headers: { "cache-control": "private, no-store" },
  }) : kind === "missing" ? validatedProblem({
    status: 404, code: "PROBLEM_NOT_FOUND", title: "Public problem not found",
    detail: "No public problem is available at this identifier.",
    fixHint: "Choose a problem from /problems.json.",
    headers: { "cache-control": "private, no-store" },
  }) : validatedProblem({
    status: 500, code: "INTERNAL_ERROR", title: "The public event page is unavailable",
    detail: "A complete public event page could not be established. No resume cursor was advanced.",
    fixHint: "Retry the unchanged request without advancing your saved cursor.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
  return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export function createEventTailRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "ndjson"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/events.${format}`, async (c) => {
      const id = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = parseEventTailQuery(params);
      if (!EVENT_TAIL_PROBLEM_PATTERN.test(id) || query === undefined ||
          !EventTailQuerySchema.safeParse(Object.fromEntries(params)).success)
        return refusal("query", c.req.method);
      try {
        const result = await readPublicEventTail(c.env.DB, id, query);
        if (result === null) return refusal("missing", c.req.method);
        const page = EventTailResponseSchema.parse(result.page);
        return await eventTailResponse(c.req.raw, page, format, result.unlisted);
      } catch (error) {
        // No thrown message, SQL, request query or private identifier is logged/reflected.
        return refusal(error instanceof EventTailReadError && error.code === "CURSOR_INVALID"
          ? "query" : "unavailable", c.req.method);
      }
    });
  }
  return app;
}
