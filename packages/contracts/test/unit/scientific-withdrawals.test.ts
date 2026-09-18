import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  generateScientificWithdrawalsSchema,
  SCIENTIFIC_WITHDRAWALS_SCHEMA_ID,
  ScientificWithdrawalReceiptSchema,
  ScientificWithdrawalRequestSchema,
} from "../../src/scientific-withdrawals.ts";

const request = {
  source_event_id: "E-source",
  source_digest: `sha256:${"a".repeat(64)}`,
  reason: "The author identified an error.",
};

test("an exact source and substantive reason form the withdrawal request", () => {
  assert.deepEqual(ScientificWithdrawalRequestSchema.parse(request), request);
});

test("actor overrides, missing pins and empty explanations are refused", () => {
  for (const value of [
    { ...request, actor: "admin" },
    { ...request, source_digest: "latest" },
    { ...request, reason: "          " },
    { ...request, reason: "123456789 " },
    { ...request, reason: "x".repeat(2001) },
  ])
    assert.equal(ScientificWithdrawalRequestSchema.safeParse(value).success, false);
});

test("a receipt pins the correction without accepting a fabricated disposition", () => {
  const receipt = {
    schema: SCIENTIFIC_WITHDRAWALS_SCHEMA_ID,
    ok: true,
    event_id: "E-correction",
    retraction_id: "R-EXAMPLE",
    problem_id: "P-DEMO",
    target_kind: "review",
    target_object: "R-review",
    target_event_id: request.source_event_id,
    target_digest: request.source_digest,
    claim_id: "C-1",
    claim_version: 1,
    retraction_kind: "self-corrected",
    seq: 3,
    created_at: "2026-09-17T00:00:00.000Z",
  };
  assert.deepEqual(ScientificWithdrawalReceiptSchema.parse(receipt), receipt);
  assert.equal(
    ScientificWithdrawalReceiptSchema.safeParse({ ...receipt, disposition: "proved" }).success,
    false,
  );
});

test("the public schema is generated from the same request and receipt source", () => {
  const schema = JSON.parse(generateScientificWithdrawalsSchema());
  assert.equal(schema.$id, SCIENTIFIC_WITHDRAWALS_SCHEMA_ID);
  assert.ok(schema.properties.request);
  assert.ok(schema.properties.receipt);
});
