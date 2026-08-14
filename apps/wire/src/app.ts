import { Hono } from "hono";
import type { Env } from "./env";
import { problem } from "./http/envelope";
import { handleHealth } from "./http/health";
import { redactPathname } from "./http/redact";

/**
 * The Stoa application.
 *
 * At OPS.1 it serves exactly one route — the internal health scaffold. The
 * public agent surface (Fable §7.9) arrives with W4–W6; adding routes here
 * ahead of their contracts would put untyped endpoints in front of
 * `@asimposium/contracts` and invert the "contracts before endpoints" rule.
 */
export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/internal/health", (c) => handleHealth({ format: c.req.query("format"), env: c.env }));

  app.notFound((c) =>
    problem({
      status: 404,
      code: "ROUTE_NOT_FOUND",
      title: "No such route",
      // The path is echoed so the caller can see what it actually asked for,
      // but never verbatim: an agent that put a credential in a URL must not
      // get it handed back (Fable §14.2).
      detail: `This Worker serves no route at ${redactPathname(new URL(c.req.url).pathname)}.`,
      fixHint:
        "Only GET /internal/health exists on this scaffold; the agent surface lands with the session and ledger workstreams.",
    }),
  );

  app.onError((err, c) => {
    // Server-side breadcrumb without the message: the never-log list (Fable
    // §14.3) treats raw bodies and unredacted error text as unsafe until the
    // observability pipeline that scrubs them exists.
    console.error("[wire] unhandled error", {
      path: redactPathname(new URL(c.req.url).pathname),
      error: err instanceof Error ? err.name : "unknown",
    });
    return problem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The Worker failed to handle this request",
      detail: "An unexpected error occurred. Its details are not disclosed on this face.",
      fixHint: "Retry the request. If it persists, report the route and the time of the attempt.",
    });
  });

  return app;
}
