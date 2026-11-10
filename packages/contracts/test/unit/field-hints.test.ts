import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { isSingleEdit, requestFieldHints } from "../../src/field-hints.ts";
import {
  OPAQUE_PROBLEM_CODES,
  PROBLEM_TYPE_PREFIX,
  ProblemDocumentSchema,
} from "../../src/problem.ts";
import {
  PromoteRequestSchema,
  SessionOpenRequestSchema,
  WorkshopPushRequestSchema,
} from "../../src/sessions.ts";

function hints(schema: z.ZodType, body: unknown) {
  const before = JSON.stringify(body);
  const result = schema.safeParse(body);
  if (result.success) throw new Error("This test requires a rejected request");
  const suggested = requestFieldHints(schema, body);
  expect(JSON.stringify(body)).toBe(before);
  expect(schema.safeParse(body).success).toBe(false);
  return suggested;
}

test("core object and union contracts teach top-level names without accepting a typo", () => {
  expect(hints(SessionOpenRequestSchema, { problemId: "P-DISC-A" })).toEqual({
    suggested_fields: ["problem_id"],
  });
  expect(
    hints(WorkshopPushRequestSchema, {
      type: "scratch",
      title: "Private",
      bodymd: "PRIVATE-FIELD-VALUE",
    }),
  ).toEqual({ suggested_fields: ["body_md"] });
  expect(
    hints(PromoteRequestSchema, {
      workshopid: "PRIVATE-WORKSHOP-ID",
      kind: "definition",
      statement: "A finite set has finitely many elements.",
    }),
  ).toEqual({ suggested_fields: ["workshop_id"] });
});

test("ambiguity, known fields, nested issues, dynamic records and untrusted keys teach nothing", () => {
  expect(
    hints(z.object({ from: z.string(), fork: z.string() }).strict(), { form: "PRIVATE" }),
  ).toEqual({});
  expect(
    hints(z.object({ foo_bar: z.string(), foobar: z.string() }).strict(), { fooBar: "PRIVATE" }),
  ).toEqual({});
  expect(hints(SessionOpenRequestSchema, { problem_id: 7 })).toEqual({});
  expect(
    hints(SessionOpenRequestSchema, { problem_id: "P-DISC-A", problemId: "PRIVATE-OTHER" }),
  ).toEqual({});
  expect(
    hints(SessionOpenRequestSchema, { problem_id: "P-DISC-A", declared: { harenss: "PRIVATE" } }),
  ).toEqual({});
  expect(hints(z.record(z.string(), z.number()), { arbitrary: "PRIVATE" })).toEqual({});
  for (const key of [
    "totally_unrelated",
    `asimp_ag_${"A".repeat(43)}`,
    `v1.${"B".repeat(43)}`,
    `flow_v1.${"C".repeat(43)}`,
    "x".repeat(1000),
    "__proto__",
  ]) {
    expect(
      hints(SessionOpenRequestSchema, JSON.parse(`{${JSON.stringify(key)}:"PRIVATE"}`)),
    ).toEqual({});
  }
});

test("hints have a stable bounded prefix and never echo rejected names or values", () => {
  const schema = z
    .object({ alpha: z.string(), bravo: z.string(), charlie: z.string(), delta: z.string() })
    .strict();
  const body = { alph: "PRIVATE-A", brav: "PRIVATE-B", charli: "PRIVATE-C", delt: "PRIVATE-D" };
  const result = hints(schema, body);
  expect(result).toEqual({ suggested_fields: ["alpha", "bravo", "charlie"] });
  expect(hints(schema, Object.fromEntries(Object.entries(body).reverse()))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("shared edit matching keeps exact, insertion, deletion, substitution and transposition behavior", () => {
  for (const [a, b] of [
    ["sessions", "sessions"],
    ["session", "sessions"],
    ["sessions", "session"],
    ["sessxons", "sessions"],
    ["sessinos", "sessions"],
  ] as const)
    expect(isSingleEdit(a, b)).toBe(true);
  expect(isSingleEdit("sesiosns", "sessions")).toBe(false);
  expect(isSingleEdit("", "ab")).toBe(false);
});

test("field-hint goldens agree in Zod and JSON Schema and never widen policy refusals", async () => {
  const published = await Bun.file(
    new URL("../../generated/problem.schema.json", import.meta.url),
  ).json();
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $schema: published.$schema,
    $defs: published.$defs,
    ...published.properties.problem_document,
  });
  for (const [directory, name, valid] of [
    ["valid", "field-hints", true],
    ["invalid", "field-hints-policy", false],
    ["invalid", "field-hints-value", false],
  ] as const) {
    const document = await Bun.file(
      new URL(`../fixtures/${directory}/${name}.json`, import.meta.url),
    ).json();
    expect(ProblemDocumentSchema.safeParse(document).success, name).toBe(valid);
    expect(validate(document), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(valid);
  }
  const base = await Bun.file(
    new URL("../fixtures/invalid/field-hints-policy.json", import.meta.url),
  ).json();
  for (const code of OPAQUE_PROBLEM_CODES) {
    const document = { ...base, code, type: `${PROBLEM_TYPE_PREFIX}${code}` };
    expect(ProblemDocumentSchema.safeParse(document).success, code).toBe(false);
    expect(validate(document), code).toBe(false);
  }
});
