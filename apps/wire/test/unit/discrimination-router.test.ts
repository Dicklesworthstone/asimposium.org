import { test } from "bun:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { discriminationBatchRequest } from "@asimposium/contracts/discrimination";
import type { Env } from "../../src/env.ts";
import { createDiscriminationRouter } from "../../src/sessions/discrimination-router.ts";

function work() {
  return {
    kind: "argument", source: { kind: "model_memory" }, mode: "exploratory",
    work: {
      question: "Which route predicts the finite boundary?",
      protocol: "Evaluate the shared boundary case and compare the predicted signs.",
      observation: "The boundary observable is zero.",
      limitations: "This is a written argument, not independent verification.",
      prediction_timing_self_declared: "after-observation",
      cases: [
        { hypothesis_id: "H-1", prediction: "Zero", would_count_against: "A nonzero value", direction: "informs", interpretation: "Consistent only at this boundary." },
        { hypothesis_id: "H-2", prediction: "Strictly positive", would_count_against: "Zero", direction: "refutes", interpretation: "The boundary conflicts with this route." },
      ],
    },
  };
}
const headers = { authorization: "Bearer test-only", "idempotency-key": "experiment-1", "content-type": "application/json" };

// This fixture proves routing and response ownership, not real authentication,
// screening, transaction atomicity or D1 behavior. Those belong to the writer.
for (const status of [201, 200, 401, 403, 409, 422, 429, 503]) {
  test(`ordinary writer's ${status} receipt or refusal is returned byte-for-byte`, async () => {
    const ledger = new Hono<{ Bindings: Env }>();
    let calls = 0;
    const responseBody = JSON.stringify({ status, marker: "ordinary-writer" });
    ledger.post("/v1/p/:id/events:batch", async (c) => {
      calls += 1;
      assert.equal(c.req.param("id"), "P-TEST");
      assert.equal(c.req.header("authorization"), headers.authorization);
      assert.equal(c.req.header("idempotency-key"), headers["idempotency-key"]);
      assert.deepEqual(await c.req.json(), discriminationBatchRequest(work(), "P-TEST"));
      return new Response(responseBody, { status, headers: { "cache-control": "private, no-store", "x-writer": "canonical" } });
    });
    const response = await createDiscriminationRouter(ledger).request("/v1/p/P-TEST/discrimination", { method: "POST", headers, body: JSON.stringify(work()) }, {} as Env);
    assert.equal(calls, 1);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-writer"), "canonical");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(await response.text(), responseBody);
  });
}

test("invalid contrast refuses before delegating any member", async () => {
  const ledger = new Hono<{ Bindings: Env }>();
  let calls = 0;
  ledger.post("/v1/p/:id/events:batch", (c) => { calls += 1; return c.text("unexpected", 201); });
  const body = work();
  body.work.cases[1]!.prediction = body.work.cases[0]!.prediction;
  const response = await createDiscriminationRouter(ledger).request("/v1/p/P-TEST/discrimination", { method: "POST", headers, body: JSON.stringify(body) }, {} as Env);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const refusal = await response.json() as { code: string; schema: string };
  assert.equal(refusal.code, "SCHEMA_INVALID");
  assert.equal(refusal.schema, "https://a.asimposium.org/schemas/discrimination.v1.json");
});

test("oversized input is refused before writer delegation", async () => {
  const ledger = new Hono<{ Bindings: Env }>();
  let calls = 0;
  ledger.post("/v1/p/:id/events:batch", (c) => { calls += 1; return c.text("unexpected", 201); });
  const response = await createDiscriminationRouter(ledger).request("/v1/p/P-TEST/discrimination", { method: "POST", headers, body: " ".repeat(32769) }, {} as Env);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});
