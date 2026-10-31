import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ActiveDirectiveQuerySchema, ActiveDirectiveResponseSchema, generateDirectivesSchema } from "../../src/directives.ts";
import { ContractProblemSchema } from "../../src/problem.ts";
import { generatedArtifacts } from "../../src/artifacts.ts";
import { getPublicSchema } from "../../src/public-schemas.ts";

const golden = JSON.parse(readFileSync(new URL("../fixtures/active-directive-golden.json", import.meta.url), "utf8"));

test("active-directive query and completion fixtures agree with generated JSON Schema", () => {
  const document = JSON.parse(generateDirectivesSchema());
  const ajv = new Ajv2020({ strict: false });
  for (const [name, schema, generated] of [
    ["query", ActiveDirectiveQuerySchema, document.active_query],
    ["response", ActiveDirectiveResponseSchema, document.active_response],
  ] as const) {
    const validate = ajv.compile(generated);
    for (const [prefix, valid] of [["valid", true], ["invalid", false]] as const) {
      const fixture = golden[`${prefix}_${name}`];
      expect(schema.safeParse(fixture).success).toBe(valid);
      expect(validate(fixture)).toBe(valid);
    }
  }
  expect(ActiveDirectiveQuerySchema.parse({})).toEqual({ limit: 50 });
  expect(ActiveDirectiveQuerySchema.safeParse({ since: 0 }).success).toBe(false);
});

test("all directive continuation refusals teach and missing teaching fields are rejected", () => {
  for (const fixture of golden.valid_errors) expect(ContractProblemSchema.safeParse(fixture).success).toBe(true);
  for (const fixture of golden.invalid_errors) expect(ContractProblemSchema.safeParse(fixture).success).toBe(false);
});

test("focus, scope and completion invariants are structural in the served contract", () => {
  const schema = ActiveDirectiveResponseSchema;
  for (const response of [
    { ...golden.valid_response, scope: "global" },
    { ...golden.valid_response, focus: { ...golden.valid_response.focus, text: "Cannot attach text to unfocus." } },
    { ...golden.valid_response, next_cursor: "ad1." + "a".repeat(64) + ".12.1" },
    { ...golden.valid_response, private_body: "Unknown field" },
  ]) {
    expect(schema.safeParse(response).success).toBe(false);
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(generateDirectivesSchema()).active_response);
    expect(validate(response)).toBe(false);
  }
});

test("directive and teaching-error artifacts are registered and current", () => {
  expect(getPublicSchema("directives")?.body).toBe(generateDirectivesSchema());
  for (const path of ["generated/directives.schema.json", "generated/directives.types.ts", "generated/problem.schema.json"]) {
    const expected = generatedArtifacts().find(artifact => artifact.relativePath === path);
    expect(expected).toBeDefined();
    expect(readFileSync(new URL("../../" + path, import.meta.url), "utf8")).toBe(expected!.content);
  }
});
