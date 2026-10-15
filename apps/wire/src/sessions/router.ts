import { PackResponseSchema, PackTargetQuerySchema } from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { createReviewRequestRouter } from "../review-requests/router.ts";
import { recoverIdleSessionSlots } from "./admission-recovery.ts";
import { createDiscriminationRouter } from "./discrimination-router.ts";
import { createFrictionRouter } from "./friction-router.ts";
import { ReviewPackSelectionError, selectIsolatedReviewPack } from "./review-pack-selection.ts";
import {
  createSessionRouter as createLedgerSessionRouter,
  type SessionRouterOptions,
} from "./router-core.ts";
import { createScientificWithdrawalRouter } from "./scientific-withdrawal-router.ts";
import { createSponsorWorkshopIndexRouter } from "./sponsor-workshop-index.ts";

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
  app.get("/v1/sessions/:id/pack", async (c, next) => {
    try {
      // A local Hono request may not carry a Worker execution context.
      let execution: Parameters<typeof ledger.fetch>[2];
      try {
        execution = c.executionCtx;
      } catch {
        execution = undefined;
      }
      const response = await selectIsolatedReviewPack(c.req.raw, c.req.param("id"), {
        read: async (request) => ledger.fetch(request, c.env, execution),
        parsePack: (value) => PackResponseSchema.parse(value),
        parseTarget: (value) => PackTargetQuerySchema.parse(value),
      });
      if (response === undefined) return next();
      c.header("cache-control", "private, no-store");
      return response;
    } catch (error) {
      const needsTarget = error instanceof ReviewPackSelectionError && error.kind === "target-required";
      return validatedProblem({
        status: needsTarget ? 400 : 503,
        code: needsTarget ? "SCHEMA_INVALID" : "INTERNAL_ERROR",
        title: needsTarget ? "An exact review target is needed" : "Review selection is temporarily unavailable",
        detail: needsTarget
          ? "The bounded authenticated queue did not supply an eligible exact claim version. No broad claims context, private invitations, workshop or handback was returned."
          : "An isolated review target could not be read safely. No broad review context was returned.",
        fixHint: needsTarget
          ? "Read this session's review-queue pack or supply profile=review&target=C-1@1 using an actual public claim version. Selection does not reserve work or grant publication permission."
          : "Retry the unchanged request, or request an isolated review pack with an explicit public claim@version.",
        rule: "P12",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { profile: "review", target: "C-1@1" },
        },
        headers: {
          "cache-control": "private, no-store",
          ...(needsTarget ? {} : { "retry-after": "5" }),
        },
      });
    }
  });
  app.route("/", createSponsorWorkshopIndexRouter(options));
  app.route("/", createScientificWithdrawalRouter(options));
  app.route("/", createReviewRequestRouter(options));
  app.route("/", createFrictionRouter(ledger));
  app.route("/", createDiscriminationRouter(ledger));
  app.route("/", ledger);
  return app;
}
