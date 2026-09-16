import { Hono } from "hono";
import type { Env } from "../env.ts";
import { createReviewRequestRouter } from "../review-requests/router.ts";
import {
  createSessionRouter as createLedgerSessionRouter,
  type SessionRouterOptions,
} from "./router-core.ts";

// Keep every existing session helper/type available to callers and tests. The
// ledger implementation is moved byte-for-byte, not rewritten to add a route.
export * from "./router-core.ts";
export function createSessionRouter(options: SessionRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createReviewRequestRouter(options));
  app.route("/", createLedgerSessionRouter(options));
  return app;
}
