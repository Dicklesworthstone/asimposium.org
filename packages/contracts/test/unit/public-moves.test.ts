import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { ProblemNextResponseSchema } from "../../src/mega-commands.ts";
import { generateMoveTemplatesDocument } from "../../src/moves.ts";
import {
  PublicMoveDiscoverySchema,
  PublicMovesQuerySchema,
  PublicMovesResponseSchema,
  PublicProblemMovesSchema,
} from "../../src/public-moves.ts";

const fixture = (kind: string, name: string) =>
  Bun.file(new URL(`../fixtures/${kind}/${name}.json`, import.meta.url)).json();

test("authenticated next role advice is typed, advisory and compatible with absent advice", async () => {
  const schema = await Bun.file(
    new URL("../../generated/moves.schema.json", import.meta.url),
  ).json();
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const validate = ajv.compile(schema.$defs.authenticated_next);
  for (const [kind, expected] of [
    ["valid", true],
    ["invalid", false],
  ] as const) {
    const input = await fixture(kind, "next-role-suggestion");
    expect(ProblemNextResponseSchema.safeParse(input).success).toBe(expected);
    expect(validate(input), JSON.stringify(validate.errors)).toBe(expected);
  }
  const input = await fixture("valid", "next-role-suggestion");
  for (const suggestion of [undefined, null]) {
    const value = { ...input, viewer: { ...input.viewer, role_suggestion: suggestion } };
    expect(ProblemNextResponseSchema.safeParse(value).success).toBe(true);
    expect(validate(value)).toBe(true);
  }
  for (const suggestion of [
    { ...input.viewer.role_suggestion, suggested_role: "steward" },
    { ...input.viewer.role_suggestion, effective_permissions: { promote: true } },
  ]) {
    const value = { ...input, viewer: { ...input.viewer, role_suggestion: suggestion } };
    expect(ProblemNextResponseSchema.safeParse(value).success).toBe(false);
    expect(validate(value)).toBe(false);
  }
});

test("public move golden contracts agree with the served JSON Schema", async () => {
  const schema = await Bun.file(
    new URL("../../generated/moves.schema.json", import.meta.url),
  ).json();
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const [kind, name, zod, definition, expected] of [
    ["valid", "public-moves-query", PublicMovesQuerySchema, "public_query", true],
    ["invalid", "public-moves-query", PublicMovesQuerySchema, "public_query", false],
    ["valid", "public-problem-moves", PublicProblemMovesSchema, "public_problem", true],
    ["invalid", "public-problem-moves-write", PublicProblemMovesSchema, "public_problem", false],
  ] as const) {
    const input = await fixture(kind, name);
    const validate = ajv.compile(schema.$defs[definition]);
    expect(zod.safeParse(input).success, name).toBe(expected);
    expect(validate(input), `${name}: ${JSON.stringify(validate.errors)}`).toBe(expected);
  }
  const page = {
    scope: "public-needs",
    problems: [await fixture("valid", "public-problem-moves")],
    scanned: 1,
    next_after: null,
    degraded: true,
    omitted: [],
    selection_boundary: "One bounded public admission page.",
  };
  const document = { ...generateMoveTemplatesDocument(), discovery: page };
  expect(PublicMovesResponseSchema.safeParse(document).success).toBe(true);
  expect(ajv.compile(schema)(document)).toBe(true);
  expect(PublicMovesResponseSchema.safeParse(generateMoveTemplatesDocument()).success).toBe(false);
  expect(
    PublicMoveDiscoverySchema.safeParse({ ...page, problems: Array(5).fill(page.problems[0]) })
      .success,
  ).toBe(false);
});

test("public discovery requires explicit omissions, safe cursors and read-only permissions", async () => {
  const valid = await fixture("valid", "public-problem-moves");
  const { omitted: _omitted, ...missingOmissions } = valid;
  expect(PublicProblemMovesSchema.safeParse(missingOmissions).success).toBe(false);
  for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(PublicProblemMovesSchema.safeParse({ ...valid, captured_cursor: cursor }).success).toBe(
      false,
    );
  for (const permission of ["session_open", "workshop_push", "promote", "review"])
    expect(
      PublicProblemMovesSchema.safeParse({
        ...valid,
        viewer: {
          ...valid.viewer,
          effective_permissions: { ...valid.viewer.effective_permissions, [permission]: true },
        },
      }).success,
    ).toBe(false);
});
