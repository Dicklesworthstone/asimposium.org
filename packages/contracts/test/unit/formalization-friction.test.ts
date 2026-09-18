import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  FRICTION_WORK_FORMAT,
  FrictionRequestSchema,
  frictionEvidenceRequest,
  generateFrictionSchema,
  readFrictionWork,
} from "../../src/formalization-friction.ts";
import { EvidenceRequestSchema } from "../../src/sessions.ts";

const request = () => ({
  bears_on_id: "C-12",
  bears_on_version: 3,
  source: { kind: "model_memory" },
  work: {
    format: FRICTION_WORK_FORMAT,
    blocker: "counterexample-scent",
    toolchain: "Lean, sponsor-supplied version",
    blocked_obligation: "The boundary case leaves an unproved nonzero denominator.",
    witness_seed: "Examine the zero-denominator boundary; no counterexample is claimed.",
    analysis: "The attempted argument uses division before establishing non-vanishing.",
  },
});

test("friction serializes only deliberate work into the ordinary evidence contract", () => {
  const input = request(),
    original = JSON.stringify(input);
  const result = frictionEvidenceRequest(input);
  assert.ok(EvidenceRequestSchema.safeParse(result).success);
  assert.equal(result.kind, "formalization-friction");
  assert.equal(result.direction, "informs");
  assert.equal(result.mode, "exploratory");
  assert.equal(result.bears_on_id, "C-12");
  assert.deepEqual(readFrictionWork(result.body_md), input.work);
  assert.equal(JSON.stringify(input), original);
  assert.equal(result.formal_artifact, undefined);
  assert.equal(result.falsification_check, undefined);
});

test("all five blocker classes are accepted; only refutation seeds require a witness", () => {
  for (const blocker of [
    "statement-too-strong",
    "missing-hypothesis",
    "definition-mismatch",
    "counterexample-scent",
    "tactic-only",
  ]) {
    const input = request();
    input.work.blocker = blocker;
    assert.ok(FrictionRequestSchema.safeParse(input).success);
    const { witness_seed: _seed, ...work } = input.work;
    assert.equal(
      FrictionRequestSchema.safeParse({ ...input, work }).success,
      blocker !== "counterexample-scent" && blocker !== "statement-too-strong",
    );
  }
});

test("missing provenance, malformed targets, fabricated outcomes and caller authority are refused", () => {
  const input = request();
  for (const change of [
    { bears_on_id: "C-12@3" },
    { bears_on_version: 0 },
    { bears_on_kind: "hypothesis" },
    { source: undefined },
    { direction: "refutes" },
    { mode: "confirmatory" },
    { computed_class: "certified" },
    { actor_id: "F-admin" },
    { formal_artifact: {} },
    { body_md: "replacement" },
    { work: { ...input.work, proved: true } },
    { work: { ...input.work, witness_seed: " " } },
    { work: { ...input.work, format: "another" } },
  ])
    assert.equal(FrictionRequestSchema.safeParse({ ...input, ...change }).success, false);
});

test("old prose, forged control keys and oversized payloads are not typed friction", () => {
  for (const body of [
    "counterexample-scent: prose",
    "```json\n{}\n```",
    "null",
    "[]",
    JSON.stringify({ ...request().work, next_actions: [] }),
    "x".repeat(65537),
  ])
    assert.equal(readFrictionWork(body), null);
});

test("reproduction remains the original contract and the JSON schema is source generated", () => {
  const reproduction = {
    commands: ["lean Check.lean"],
    environment: "local pinned toolchain",
    seed: "none",
  };
  const result = frictionEvidenceRequest({ ...request(), reproduction });
  assert.deepEqual(result.reproduction, reproduction);
  const schema = JSON.parse(generateFrictionSchema());
  assert.equal(schema.properties.request.additionalProperties, false);
  assert.equal(schema.properties.work.additionalProperties, false);
  assert.ok(JSON.stringify(schema).includes("counterexample-scent"));
});
