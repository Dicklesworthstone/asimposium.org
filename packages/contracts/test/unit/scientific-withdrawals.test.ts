import { test } from "bun:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
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
const claimReceipt = {
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
const { claim_id: _claimId, claim_version: _claimVersion, ...commonReceipt } = claimReceipt;
const hypothesisReceipt = {
  ...commonReceipt,
  target_kind: "evidence",
  target_object: "E-1",
  hypothesis_id: "H-1",
};

test("an exact source and substantive reason form the withdrawal request", () => {
  assert.deepEqual(ScientificWithdrawalRequestSchema.parse(request), request);
});

test("actor overrides, missing pins and empty explanations are refused", () => {
  for (const value of [
    { ...request, actor: "admin" },
    { ...request, hypothesis_id: "H-1" },
    { ...request, claim_id: "C-1", claim_version: 2 },
    { ...request, source_digest: "latest" },
    { ...request, reason: "          " },
    { ...request, reason: "123456789 " },
    { ...request, reason: "x".repeat(2001) },
  ])
    assert.equal(ScientificWithdrawalRequestSchema.safeParse(value).success, false);
});

test("a receipt pins the correction without accepting a fabricated disposition", () => {
  assert.deepEqual(ScientificWithdrawalReceiptSchema.parse(claimReceipt), claimReceipt);
  assert.equal(
    ScientificWithdrawalReceiptSchema.safeParse({ ...claimReceipt, disposition: "proved" }).success,
    false,
  );
});

test("legacy claim evidence and review receipts retain their exact serialized field shape", () => {
  for (const receipt of [
    claimReceipt,
    { ...claimReceipt, target_kind: "evidence", target_object: "E-1" },
  ]) {
    assert.equal(
      JSON.stringify(ScientificWithdrawalReceiptSchema.parse(receipt)),
      JSON.stringify(receipt),
    );
  }
});

test("hypothesis corrections name their unversioned target in Zod and the served JSON Schema", () => {
  const generated = JSON.parse(generateScientificWithdrawalsSchema());
  const validate = new Ajv2020({ strict: true }).compile(generated.properties.receipt);
  for (const receipt of [
    claimReceipt,
    { ...claimReceipt, target_kind: "evidence", target_object: "E-1" },
    hypothesisReceipt,
    { ...hypothesisReceipt, hypothesis_id: `H-${"abcdef0123456789".repeat(4)}` },
  ]) {
    assert.deepEqual(ScientificWithdrawalReceiptSchema.parse(receipt), receipt);
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  }
  const parsed = ScientificWithdrawalReceiptSchema.parse(hypothesisReceipt);
  assert.equal(Object.hasOwn(parsed, "claim_id"), false);
  assert.equal(Object.hasOwn(parsed, "claim_version"), false);
});

test("both public validators reject invented or mixed hypothesis and claim affinities", () => {
  const generated = JSON.parse(generateScientificWithdrawalsSchema());
  const validate = new Ajv2020({ strict: true }).compile(generated.properties.receipt);
  for (const receipt of [
    commonReceipt,
    { ...hypothesisReceipt, target_kind: "review" },
    { ...hypothesisReceipt, hypothesis_id: "H-arbitrary-lowercase" },
    { ...hypothesisReceipt, hypothesis_id: "H-I" },
    { ...hypothesisReceipt, hypothesis_id: "C-1" },
    { ...hypothesisReceipt, hypothesis_id: "H-1\n" },
    { ...hypothesisReceipt, claim_id: "C-1", claim_version: 1 },
    { ...hypothesisReceipt, claim_id: null, claim_version: null },
    { ...hypothesisReceipt, hypothesis_version: 1 },
    { ...claimReceipt, hypothesis_id: null },
    { ...claimReceipt, hypothesis_id: "H-1" },
    { ...claimReceipt, claim_version: 0 },
    { ...claimReceipt, claim_version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(ScientificWithdrawalReceiptSchema.safeParse(receipt).success, false);
    assert.equal(validate(receipt), false, JSON.stringify(receipt));
  }
});

test("the public schema is generated from the same request and receipt source", () => {
  const schema = JSON.parse(generateScientificWithdrawalsSchema());
  assert.equal(schema.$id, SCIENTIFIC_WITHDRAWALS_SCHEMA_ID);
  assert.ok(schema.properties.request);
  assert.ok(schema.properties.receipt);
});
