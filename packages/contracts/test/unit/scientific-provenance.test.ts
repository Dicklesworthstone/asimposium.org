import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  GroundedFalsificationCheckSchema,
  ScientificProvenanceSchema,
  ScientificVerificationSchema,
} from "../../src/scientific-provenance.ts";
import { SessionsContractsSchema } from "../../src/sessions.ts";

const digest = `sha256:${"a".repeat(64)}`;
const reference = { evidence_id: "E-123", digest };
const check = {
  target_digest: digest,
  attempted_falsifier: "Find n with no prime at least n.",
  capable_of_failure: "Exhibit such an n and establish the upper bound.",
  result: "survived",
  evidence: [reference],
};

test("grounded checks require exact digests and existing-reference shapes", () => {
  expect(GroundedFalsificationCheckSchema.safeParse(check).success).toBe(true);
  for (const mutation of [
    { target_digest: undefined },
    { target_digest: "not-a-digest" },
    { evidence: [] },
    { evidence: ["E-123"] },
    { result: "proved" },
    { capable_of_failure: " " },
  ])
    expect(GroundedFalsificationCheckSchema.safeParse({ ...check, ...mutation }).success).toBe(
      false,
    );
});

test("a scientific method is a stated procedure; a family is an explicit declaration", () => {
  expect(ScientificProvenanceSchema.parse({})).toEqual({ model_family_self_declared: null });
  expect(
    ScientificProvenanceSchema.parse({ model_family_self_declared: "GPT" })
      .model_family_self_declared,
  ).toBe("gpt");
  expect(
    ScientificProvenanceSchema.safeParse({ model_family_self_declared: "unknown" }).success,
  ).toBe(false);
  expect(
    ScientificProvenanceSchema.safeParse({ model_family_self_declared: "openai/gpt-5.6" }).success,
  ).toBe(false);
  expect(
    ScientificProvenanceSchema.safeParse({ method: { category: "computation" } }).success,
  ).toBe(false);
  expect(
    ScientificProvenanceSchema.safeParse({
      method: { category: "codex", procedure: "Use a harness" },
    }).success,
  ).toBe(false);
});

test("verification records bind actual material; truth checkboxes are not verification", () => {
  const verification = {
    kind: "full-write-up",
    target_digest: digest,
    evidence: reference,
    coverage: ["Quantifier scope", "Prime-divisor argument", "n=0,1"],
    result: "verified",
  };
  expect(ScientificVerificationSchema.safeParse(verification).success).toBe(true);
  expect(ScientificVerificationSchema.safeParse({ full_write_up: true }).success).toBe(false);
  expect(
    ScientificVerificationSchema.safeParse({ ...verification, evidence: undefined }).success,
  ).toBe(false);
  expect(ScientificVerificationSchema.safeParse({ ...verification, coverage: [] }).success).toBe(
    false,
  );
  expect(
    ScientificVerificationSchema.safeParse({ ...verification, artifact_compilation: true }).success,
  ).toBe(false);
});

test("publication golden corpus agrees in canonical Zod and served JSON Schema", async () => {
  const valid = await Bun.file(
    new URL("../fixtures/valid/scientific-publications.json", import.meta.url),
  ).json();
  const invalid = await Bun.file(
    new URL("../fixtures/invalid/scientific-publications.json", import.meta.url),
  ).json();
  const schema = await Bun.file(
    new URL("../../generated/sessions.schema.json", import.meta.url),
  ).json();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const [contract, body] of Object.entries(valid)) {
    const validator =
      SessionsContractsSchema.shape[contract as keyof typeof SessionsContractsSchema.shape];
    expect(validator.safeParse(body).success, contract).toBe(true);
    expect(ajv.compile(schema.properties[contract])(body), contract).toBe(true);
  }
  for (const fixture of invalid) {
    const validator =
      SessionsContractsSchema.shape[fixture.contract as keyof typeof SessionsContractsSchema.shape];
    expect(validator.safeParse(fixture.body).success, fixture.code).toBe(false);
    expect(ajv.compile(schema.properties[fixture.contract])(fixture.body), fixture.code).toBe(
      false,
    );
  }
});
