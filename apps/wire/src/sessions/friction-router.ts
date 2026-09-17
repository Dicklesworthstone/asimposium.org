import { frictionEvidenceRequest, FRICTION_SCHEMA_ID } from "@asimposium/contracts/formalization-friction";
import { Hono } from "hono";
import { readBoundedRequestBody } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { FRICTION_REQUEST_MAX_BYTES, FrictionRequestError, prepareFrictionEvidenceRequest } from "./friction-request.ts";

/** A strict convenience representation, not another ledger writer. All
 * authentication, ownership, lifecycle, target freshness, screening, quotas,
 * publication and atomic replay remain in the existing evidence handler. */
export function createFrictionRouter(ledger: Hono<{ Bindings: Env }>) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/v1/sessions/:id/friction", async (c) => {
    try {
      const body = await readBoundedRequestBody(c.req.raw, FRICTION_REQUEST_MAX_BYTES);
      if (!body.ok) throw new FrictionRequestError();
      const forwarded = prepareFrictionEvidenceRequest(c.req.raw, body.bytes, frictionEvidenceRequest);
      // Hono unit requests may lack an execution context. A real Worker keeps
      // its actual context so existing post-commit fan-out still runs normally.
      let execution: Parameters<typeof ledger.fetch>[2];
      try { execution = c.executionCtx; } catch { execution = undefined; }
      return await ledger.fetch(forwarded, c.env, execution);
    } catch (error) {
      const invalid = error instanceof FrictionRequestError;
      return validatedProblem({
        status: invalid ? 400 : 500,
        code: invalid ? "SCHEMA_INVALID" : "INTERNAL_ERROR",
        title: "Formalization friction was not accepted",
        detail: invalid
          ? "Submit one exact claim version, source provenance and a deliberate typed friction work product. This route cannot certify or refute a claim."
          : "The evidence operation is unavailable. No successful publication is claimed.",
        fixHint: invalid
          ? "Read /schemas/formalization-friction.v1.json. Counterexample-scent and statement-too-strong reports require a concrete witness or search region."
          : "Retry the unchanged request with the same Idempotency-Key.",
        ...(invalid ? { rule: "A5" as const, extensions: { schema: FRICTION_SCHEMA_ID } } : {}),
        headers: { "cache-control": "private, no-store", ...(invalid ? {} : { "retry-after": "5" }) },
      });
    }
  });
  return app;
}
