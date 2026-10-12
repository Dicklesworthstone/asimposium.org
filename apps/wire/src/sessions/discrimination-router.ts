import {
  DISCRIMINATION_REQUEST_MAX_BYTES,
  DISCRIMINATION_SCHEMA_ID,
  discriminationBatchRequest,
} from "@asimposium/contracts/discrimination";
import { Hono } from "hono";
import { readBoundedRequestBody } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { DiscriminationRequestError, prepareDiscriminationBatchRequest } from "./discrimination-request.ts";

/** One experiment may bear differently on several hypotheses. All members go
 * through the existing batch/evidence path: no replacement auth, screening,
 * session attribution, quotas, scientific classification or replay store. */
export function createDiscriminationRouter(ledger: Hono<{ Bindings: Env }>) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/v1/p/:id/discrimination", async (c) => {
    try {
      const body = await readBoundedRequestBody(c.req.raw, DISCRIMINATION_REQUEST_MAX_BYTES);
      if (!body.ok) throw new DiscriminationRequestError();
      const forwarded = prepareDiscriminationBatchRequest(c.req.raw, body.bytes, discriminationBatchRequest);
      let execution: Parameters<typeof ledger.fetch>[2];
      try { execution = c.executionCtx; } catch { execution = undefined; }
      // Return the exact ordinary batch receipt/refusal. The existing writer
      // owns atomicity; this adapter never manufactures a scientific receipt.
      return await ledger.fetch(forwarded, c.env, execution);
    } catch (error) {
      const invalid = error instanceof DiscriminationRequestError;
      return validatedProblem({
        status: invalid ? 400 : 500,
        code: invalid ? "SCHEMA_INVALID" : "INTERNAL_ERROR",
        title: "The discriminating experiment was not accepted",
        detail: invalid
          ? "Supply one observed experiment with 2–8 distinct hypothesis targets and contrasting predictions. The request or expanded evidence batch exceeds its bounds or does not match the contract."
          : "The experiment batch outcome is unavailable. No successful receipt is claimed by this adapter.",
        fixHint: invalid
          ? "Read /schemas/discrimination.v1/discrimination_request.json. Include actual observations, per-route falsifiers and limitations. Retrospective or selection evidence is exploratory. Keep the input below 32 KiB and expanded batch below 256 KiB."
          : "Retry the exact request with the same Idempotency-Key to recover the original batch receipt. Do not use a fresh key to recover an uncertain outcome.",
        ...(invalid ? {
          rule: "A5" as const,
          extensions: {
            schema: DISCRIMINATION_SCHEMA_ID,
            example: {
              kind: "computation", source: { kind: "model_memory" }, mode: "exploratory",
              work: {
                question: "Which route predicts the boundary case?",
                protocol: "Evaluate the stated observable at the same boundary input for both routes.",
                observation: "The observed value was zero.",
                limitations: "Only the boundary input was tested; this is not a proof over the full domain.",
                prediction_timing_self_declared: "before-observation",
                cases: [
                  { hypothesis_id: "H-1", prediction: "Zero", would_count_against: "A nonzero value", direction: "supports", interpretation: "Consistent at this input only." },
                  { hypothesis_id: "H-2", prediction: "Strictly positive", would_count_against: "Zero or a negative value", direction: "refutes", interpretation: "The observation conflicts with this prediction." },
                ],
              },
            },
          },
        } : {}),
        headers: { "cache-control": "private, no-store", ...(invalid ? {} : { "retry-after": "5" }) },
      });
    }
  });
  return app;
}
