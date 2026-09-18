import { Hono } from "hono";
import { cancelUnconsumedRequestBody } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { createReviewRequestRouter } from "../review-requests/router.ts";
import { recoverIdleSessionSlots } from "./admission-recovery.ts";
import { createFrictionRouter } from "./friction-router.ts";
import { createScientificWithdrawalRouter } from "./scientific-withdrawal-router.ts";
import {
  createSessionRouter as createLedgerSessionRouter,
  type SessionRouterOptions,
} from "./router-core.ts";

// Keep every existing session helper/type available to callers and tests. The
// ledger implementation is moved byte-for-byte, not rewritten to add a route.
export * from "./router-core.ts";
export function createSessionRouter(options: SessionRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/v1/sessions", async (c, next) => {
    try {
      await recoverIdleSessionSlots(c.req.raw, c.env?.DB, options.service);
    } catch {
      cancelUnconsumedRequestBody(c.req.raw);
      return validatedProblem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "Session recovery is temporarily unavailable",
        detail: "Expired work slots could not be reconciled. No new session was opened.",
        fixHint: "Retry the unchanged request with the same Idempotency-Key.",
        headers: { "cache-control": "private, no-store", "retry-after": "5" },
      });
    }
    return next();
  });
  const ledger = createLedgerSessionRouter(options);
  app.route("/", createScientificWithdrawalRouter(options));
  app.route("/", createReviewRequestRouter(options));
  app.route("/", createFrictionRouter(ledger));
  app.route("/", ledger);
  return app;
}
