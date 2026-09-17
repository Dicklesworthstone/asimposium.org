import { test } from "bun:test";
import assert from "node:assert/strict";
import { EvidenceRequestSchema } from "@asimposium/contracts";
import {
  FRICTION_WORK_FORMAT,
  readFrictionWork,
} from "@asimposium/contracts/formalization-friction";
import { Hono } from "hono";
import type { Env } from "../../src/env.ts";
import { createFrictionRouter } from "../../src/sessions/friction-router.ts";

// Actual Hono/Zod adapter tests. The downstream response is an explicit test
// handler, NOT a proof of production ledger authorization or persistence.
const input = () => ({
  bears_on_id: "C-2",
  bears_on_version: 1,
  source: { kind: "model_memory" },
  work: {
    format: FRICTION_WORK_FORMAT,
    blocker: "counterexample-scent",
    toolchain: "Lean / local pinned version",
    blocked_obligation: "A nonzero denominator has not been established.",
    witness_seed: "Test the zero-denominator boundary.",
    analysis: "The current derivation divides by an expression that may vanish.",
  },
});
function fixture(status = 201) {
  const seen: Request[] = [],
    ledger = new Hono<{ Bindings: Env }>();
  ledger.post("/v1/sessions/:id/evidence", async (c) => {
    seen.push(c.req.raw.clone() as unknown as Request);
    return new Response(JSON.stringify({ evidence_id: "E-7", downstream: true }), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "retry-after": "9",
      },
    });
  });
  const app = createFrictionRouter(ledger);
  return {
    seen,
    post: (body: unknown, key = "test-key") =>
      app.request(
        "https://a-staging.asimposium.org/v1/sessions/SS-test/friction",
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-credential",
            "idempotency-key": key,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        {} as Env,
      ),
  };
}
test("the mounted friction route publishes exactly the canonical evidence representation", async () => {
  const f = fixture(),
    request = input();
  const response = await f.post(request);
  assert.equal(response.status, 201);
  assert.equal(f.seen.length, 1);
  const actual = EvidenceRequestSchema.parse(await f.seen[0]!.json());
  assert.equal(actual.kind, "formalization-friction");
  assert.equal(actual.direction, "informs");
  assert.equal(actual.mode, "exploratory");
  assert.deepEqual(readFrictionWork(actual.body_md), request.work);
  assert.equal(f.seen[0]!.headers.get("authorization"), "Bearer test-credential");
  assert.equal(f.seen[0]!.headers.get("idempotency-key"), "test-key");
});
for (const status of [401, 403, 409, 422, 429, 503])
  test(`existing evidence refusal ${status} is returned unchanged`, async () => {
    const f = fixture(status),
      result = await f.post(input());
    assert.equal(result.status, status);
    assert.equal(result.headers.get("retry-after"), "9");
    assert.deepEqual(await result.json(), { evidence_id: "E-7", downstream: true });
    assert.equal(f.seen.length, 1);
  });
test("untyped, no-witness and authority-bearing requests never reach the evidence handler", async () => {
  const f = fixture();
  const { witness_seed: _seed, ...work } = input().work;
  for (const body of [
    { ...input(), work },
    { ...input(), computed_class: "certified" },
    { ...input(), direction: "refutes" },
  ])
    assert.equal((await f.post(body)).status, 400);
  assert.equal(f.seen.length, 0);
});
test("unchanged retries deliver identical downstream bodies and the caller's same key", async () => {
  const f = fixture();
  await f.post(input());
  await f.post(input());
  assert.equal(await f.seen[0]!.text(), await f.seen[1]!.text());
  assert.equal(
    f.seen[0]!.headers.get("idempotency-key"),
    f.seen[1]!.headers.get("idempotency-key"),
  );
});
