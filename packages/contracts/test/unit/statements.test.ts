import { expect, test } from "bun:test";
import {
  generateStatementsSchema,
  type PublicStatementVersion,
  PublicStatementVersionSchema,
  STATEMENTS_SCHEMA_ID,
  StatementHistoryQuerySchema,
  StatementHistoryResponseSchema,
  StatementResponseSchema,
  StatementVersionQuerySchema,
  StatementVersionSelectorSchema,
  statementHistoryMatchesQuery,
  statementHistoryPath,
  statementVersionMatchesQuery,
  statementVersionPath,
} from "../../src/statements.ts";

const statement = {
  version: 2,
  title: "Tree invariant",
  statement: "Every finite tree has n−1 edges.",
  falsifier: "An explicit counterexample.",
  motivation: "A connected-graph invariant.",
  scope: "  Finite trees.\n",
  out_of_scope: "Infinite graphs.",
  success_criteria: "A proof or counterexample.",
  updated_at: "2026-11-08T00:00:00.000Z",
  source_fellow_id: "F-author",
  acting_principal: { type: "sponsor", id: "usr_author" },
  publication: { event_id: "PG-source", seq: 4, payload_sha256: "a".repeat(64) },
} satisfies PublicStatementVersion;
const history = {
  schema: STATEMENTS_SCHEMA_ID,
  problem_id: "P-TREES",
  cursor: 10,
  after: 0,
  scanned_through: 4,
  next_after: 4,
  count: 1,
  statements: [statement],
  omitted: ["page_limit"],
};

test("statement contracts preserve complete authored bytes and legacy absence", () => {
  expect(PublicStatementVersionSchema.parse(statement).scope).toBe(statement.scope);
  const {
    scope: _scope,
    out_of_scope: _excluded,
    success_criteria: _success,
    ...legacy
  } = statement;
  expect(PublicStatementVersionSchema.parse(legacy)).toEqual(legacy);
  expect(
    PublicStatementVersionSchema.safeParse({ ...legacy, scope: "only one boundary" }).success,
  ).toBe(false);
  expect(PublicStatementVersionSchema.safeParse({ ...statement, model: "invented" }).success).toBe(
    false,
  );
  expect(
    PublicStatementVersionSchema.safeParse({
      ...statement,
      publication: { ...statement.publication, payload_sha256: `${"a".repeat(64)}\n` },
    }).success,
  ).toBe(false);
});
test("canonical nonnegative cursors and positive versions refuse coercion or ambiguity", () => {
  expect(StatementHistoryQuerySchema.parse({ through: "0", after: "0" })).toEqual({
    through: 0,
    after: 0,
  });
  expect(StatementVersionSelectorSchema.parse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  for (const value of ["01", "-1", "1.0", "1e3", "1\n", " 1", "9007199254740992", ["1", "2"], 1]) {
    expect(StatementHistoryQuerySchema.safeParse({ through: value }).success).toBe(false);
    expect(StatementVersionSelectorSchema.safeParse(value).success).toBe(false);
  }
  expect(StatementVersionSelectorSchema.safeParse("0").success).toBe(false);
  expect(StatementHistoryQuerySchema.safeParse({ through: "2", after: "3" }).success).toBe(false);
  expect(StatementVersionQuerySchema.safeParse({ after: "0" }).success).toBe(false);
  expect(StatementHistoryQuerySchema.safeParse({ limit: "99" }).success).toBe(false);
});
test("response invariants bind exact versions and advancing ranges to the captured cursor", () => {
  const face = StatementHistoryResponseSchema.parse(history);
  expect(statementHistoryMatchesQuery("P-TREES", { through: 10, after: 0 }, face)).toBe(true);
  expect(statementHistoryMatchesQuery("P-OTHER", {}, face)).toBe(false);
  expect(statementHistoryMatchesQuery("P-TREES", { through: 11 }, face)).toBe(false);
  expect(statementHistoryPath("P-TREES", "human", { through: 10, after: 4 })).toBe(
    "/p/P-TREES/history?through=10&after=4",
  );
  const exact = StatementResponseSchema.parse({
    schema: STATEMENTS_SCHEMA_ID,
    problem_id: "P-TREES",
    cursor: 4,
    statement,
  });
  expect(statementVersionMatchesQuery("P-TREES", 2, { through: 4 }, exact)).toBe(true);
  expect(statementVersionMatchesQuery("P-TREES", 3, {}, exact)).toBe(false);
  expect(statementVersionPath("P-TREES", 2, "json", { through: 4 })).toBe(
    "/p/P-TREES/statements/2.json?through=4",
  );
  expect(StatementResponseSchema.safeParse({ ...exact, cursor: 3 }).success).toBe(false);
  for (const patch of [
    { count: 0 },
    { scanned_through: 11 },
    { scanned_through: 3 },
    { next_after: 0 },
    { next_after: 3 },
    { next_after: null },
    { omitted: [] },
    { omitted: ["page_limit", "page_limit"] },
    { count: 2, statements: [statement, statement] },
  ])
    expect(
      StatementHistoryResponseSchema.safeParse({ ...history, ...patch }).success,
      JSON.stringify(patch),
    ).toBe(false);
  expect(
    StatementHistoryResponseSchema.safeParse({
      ...history,
      count: 0,
      statements: [],
      omitted: ["page_limit", "content_unavailable"],
    }).success,
  ).toBe(true);
});
test("source-generated schema exposes complete exact and bounded history contracts", () => {
  const schema = JSON.parse(generateStatementsSchema());
  expect(schema.$id).toBe(STATEMENTS_SCHEMA_ID);
  expect(schema.properties.history.properties.statements.maxItems).toBe(4);
  expect(schema.properties.response.properties.statement.dependentRequired.scope).toEqual([
    "out_of_scope",
    "success_criteria",
  ]);
  expect(schema.properties.version_query.additionalProperties).toBe(false);
  expect(schema.properties.version_selector.type).toBe("string");
});
