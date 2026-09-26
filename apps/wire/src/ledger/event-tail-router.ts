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
import { readPublicEventFeed } from "./event-feed-read";
import { eventTailExportResponse, eventTailFeedResponse } from "./event-tail-feeds";
import { eventTailResponse } from "./event-tail-http";
import { EventTailReadError } from "./event-tail-read";
import { type EventWaitRuntime, readPublicEventTailWithWait } from "./event-tail-wait";

function refusal(
  kind: "query" | "missing" | "unavailable" | "unknown_format",
  method: string,
  extra?: { format?: string },
): Response {
  let response: Response;
  if (kind === "query") {
    response = validatedProblem({
      status: 400,
      code: "CURSOR_INVALID",
      title: "Choose a valid problem event cursor",
      detail:
        "Use one canonical nonnegative since cursor, limit from 1 to 200, optional through at or after since, and optional wait from 0 to 25 seconds. Cursors cannot exceed the public problem head. Repeated parameters are refused.",
      fixHint:
        "Follow page_end.next unchanged to finish a snapshot, then page_end.poll for newer events. wait holds only an empty unpinned GET; HEAD and through pages return immediately. Honor Retry-After. Do not use the site-wide /cursor value here.",
      rule: "A5",
      extensions: {
        schema: `${EVENT_TAIL_SCHEMA_ID}#/properties/query`,
        example: { method: "GET", path: "/p/P-DEMO/events.ndjson?since=0&limit=50&wait=25" },
      },
      headers: { "cache-control": "private, no-store" },
    });
  } else if (kind === "unknown_format") {
    response = validatedProblem({
      status: 400,
      code: "UNKNOWN_FORMAT",
      title: "Unknown event tail format",
      detail: `Format '${extra?.format ?? ""}' is not supported. Supported formats: json, ndjson, toon.`,
      fixHint: "Use format=json, format=ndjson, or format=toon.",
      rule: "A1",
      extensions: {
        schema: `${EVENT_TAIL_SCHEMA_ID}#/properties/query`,
        example: { method: "GET", path: "/p/P-DEMO/events?format=ndjson" },
        allowed: ["json", "ndjson", "toon"],
      },
      headers: { "cache-control": "private, no-store" },
    });
  } else if (kind === "missing") {
    response = validatedProblem({
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      title: "Public problem not found",
      detail: "No public problem is available at this identifier.",
      fixHint: "Choose a problem from /problems.json.",
      rule: "A5",
      extensions: {
        schema: `${EVENT_TAIL_SCHEMA_ID}#/properties/response`,
        example: { method: "GET", path: "/problems.json" },
      },
      headers: { "cache-control": "private, no-store" },
    });
  } else {
    response = validatedProblem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The public event page is unavailable",
      detail:
        "A complete public event page could not be established. No resume cursor was advanced.",
      fixHint: "Retry the unchanged request without advancing your saved cursor.",
      headers: { "cache-control": "private, no-store", "retry-after": "5" },
    });
  }
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

export function createEventTailRoutes(
  options: { waitRuntime?: EventWaitRuntime } = {},
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Formatted event tails
  for (const format of ["json", "ndjson", "toon", "md"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/events.${format}`, async (c) => {
      const id = c.req.param("id");
      const url = new URL(c.req.url);
      const params = new URLSearchParams(url.searchParams);
      const lastEventId = c.req.header("last-event-id");
      if (!params.has("since") && lastEventId !== undefined && lastEventId !== null) {
        params.set("since", lastEventId);
      }
      const query = parseEventTailQuery(params);
      if (
        !EVENT_TAIL_PROBLEM_PATTERN.test(id) ||
        query === undefined ||
        !EventTailQuerySchema.safeParse(Object.fromEntries(params)).success
      ) {
        return refusal("query", c.req.method);
      }
      try {
        const result = await readPublicEventTailWithWait(
          c.env.DB,
          id,
          query,
          c.req.raw,
          options.waitRuntime,
        );
        if (result === null) return refusal("missing", c.req.method);
        const page = EventTailResponseSchema.parse(result.page);
        return await eventTailResponse(
          c.req.raw,
          page,
          format,
          result.unlisted,
          query.wait ? result.waitOutcome : undefined,
        );
      } catch (error) {
        return refusal(
          error instanceof EventTailReadError && error.code === "CURSOR_INVALID"
            ? "query"
            : "unavailable",
          c.req.method,
        );
      }
    });
  }

  // Negotiated event tail
  app.on(["GET", "HEAD"], "/p/:id/events", async (c) => {
    const id = c.req.param("id");
    const url = new URL(c.req.url);
    const params = new URLSearchParams(url.searchParams);
    if (params.getAll("format").length > 1) return refusal("query", c.req.method);
    const formatParam = params.get("format");
    params.delete("format");

    let format: "json" | "ndjson" | "toon" = "json";
    if (formatParam !== null) {
      if (formatParam === "json" || formatParam === "ndjson" || formatParam === "toon") {
        format = formatParam;
      } else {
        return refusal("unknown_format", c.req.method, { format: formatParam });
      }
    } else {
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/x-ndjson")) {
        format = "ndjson";
      } else if (accept.includes("text/vnd.toon") || accept.includes("text/plain")) {
        format = "toon";
      }
    }

    const lastEventId = c.req.header("last-event-id");
    if (!params.has("since") && lastEventId !== undefined && lastEventId !== null) {
      params.set("since", lastEventId);
    }
    const query = parseEventTailQuery(params);
    if (
      !EVENT_TAIL_PROBLEM_PATTERN.test(id) ||
      query === undefined ||
      !EventTailQuerySchema.safeParse(Object.fromEntries(params)).success
    ) {
      return refusal("query", c.req.method);
    }
    try {
      const result = await readPublicEventTailWithWait(
        c.env.DB,
        id,
        query,
        c.req.raw,
        options.waitRuntime,
      );
      if (result === null) return refusal("missing", c.req.method);
      const page = EventTailResponseSchema.parse(result.page);
      return await eventTailResponse(
        c.req.raw,
        page,
        format,
        result.unlisted,
        query.wait ? result.waitOutcome : undefined,
      );
    } catch (error) {
      return refusal(
        error instanceof EventTailReadError && error.code === "CURSOR_INVALID"
          ? "query"
          : "unavailable",
        c.req.method,
      );
    }
  });

  // Dedicated feeds: RSS, Atom, JSON Feed
  for (const [suffix, format] of [
    ["feed.rss", "rss"],
    ["feed.atom", "atom"],
    ["feed.json", "json"],
  ] as const) {
    app.on(["GET", "HEAD"], `/p/:id/${suffix}`, async (c) => {
      const id = c.req.param("id");
      if (!EVENT_TAIL_PROBLEM_PATTERN.test(id)) return refusal("missing", c.req.method);
      try {
        const result = await readPublicEventFeed(c.env.DB, id);
        if (result === null) return refusal("missing", c.req.method);
        const page = EventTailResponseSchema.parse(result.page);
        return await eventTailFeedResponse(c.req.raw, id, page, format, result.unlisted);
      } catch {
        return refusal("unavailable", c.req.method);
      }
    });
  }

  // Negotiated feed
  app.on(["GET", "HEAD"], "/p/:id/feed", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_TAIL_PROBLEM_PATTERN.test(id)) return refusal("missing", c.req.method);
    const accept = c.req.header("accept") ?? "";
    let format: "rss" | "atom" | "json" = "rss";
    if (accept.includes("application/atom+xml")) {
      format = "atom";
    } else if (
      accept.includes("application/feed+json") ||
      (accept.includes("application/json") && !accept.includes("application/rss+xml"))
    ) {
      format = "json";
    }
    try {
      const result = await readPublicEventFeed(c.env.DB, id);
      if (result === null) return refusal("missing", c.req.method);
      const page = EventTailResponseSchema.parse(result.page);
      return await eventTailFeedResponse(c.req.raw, id, page, format, result.unlisted, true);
    } catch {
      return refusal("unavailable", c.req.method);
    }
  });

  // Export face: /p/:id/export.jsonl.gz
  app.on(["GET", "HEAD"], "/p/:id/export.jsonl.gz", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_TAIL_PROBLEM_PATTERN.test(id)) return refusal("missing", c.req.method);
    const problem = await c.env.DB.prepare(
      "SELECT id, title, unlisted FROM problems WHERE id = ? AND status != 'private-draft'",
    )
      .bind(id)
      .first<{ id: string; title: string; unlisted: number }>();
    if (!problem) return refusal("missing", c.req.method);
    try {
      return await eventTailExportResponse(
        c.req.raw,
        problem.id,
        problem.title || problem.id,
        c.env.DB,
        Boolean(problem.unlisted),
      );
    } catch (e) {
      console.error("eventTailExportResponse error:", e);
      return refusal("unavailable", c.req.method);
    }
  });

  return app;
}
