import { expect, test } from "bun:test";
import {
  CLAIMS_LIST_SCHEMA_ID,
  ClaimsListQuerySchema,
  ClaimsListResponseSchema,
  claimsListMatchesQuery,
  claimsListPath,
  generateClaimsListSchema,
} from "../../src/claims-list.ts";
import invalid from "../fixtures/invalid/claims-list.json";
import valid from "../fixtures/valid/claims-list.json";

test("claims collection fixtures bind exact versions to a cut and advance past omitted bodies", () => {
  const face = ClaimsListResponseSchema.parse(valid);
  if (face.next_after === null) throw new Error("The fixture must exercise continuation");
  expect(ClaimsListResponseSchema.safeParse(invalid).success).toBe(false);
  expect(
    claimsListPath(face.problem_id, "human", { through: face.cursor, after: face.next_after }),
  ).toBe("/p/P-CLAIMS/claims?through=40&after=12");
  expect(claimsListMatchesQuery("P-CLAIMS", { through: 40, after: 0 }, face)).toBe(true);
  expect(claimsListMatchesQuery("P-OTHER", {}, face)).toBe(false);
  expect(claimsListMatchesQuery("P-CLAIMS", { through: 41 }, face)).toBe(false);
  expect(claimsListMatchesQuery("P-CLAIMS", { after: 12 }, face)).toBe(false);
  expect(ClaimsListResponseSchema.safeParse({ ...valid, count: 0, claims: [] }).success).toBe(true);
});

test("query ingress refuses ambiguous, unsafe, repeated and contradictory cursors", () => {
  expect(ClaimsListQuerySchema.parse({ through: "40", after: "12" })).toEqual({
    through: 40,
    after: 12,
  });
  expect(ClaimsListQuerySchema.parse({ through: "0" })).toEqual({ through: 0 });
  for (const query of [
    { through: ["40", "41"] },
    { through: "040" },
    { through: "-1" },
    { through: "9007199254740992" },
    { through: "4", after: "5" },
    { after: "1.0" },
    { after: "2\n" },
    { after: 2 },
    { limit: "200" },
  ])
    expect(ClaimsListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
});

test("response boundary refuses impossible counts, ordering and continuation", () => {
  const claim = valid.claims[0];
  if (claim === undefined) throw new Error("The fixture must contain a claim");
  for (const patch of [
    { count: 2 },
    { scanned_through: 41 },
    { scanned_through: 8 },
    { next_after: 0 },
    { next_after: 11 },
    { next_after: null },
    { omitted: ["content_unavailable"] },
    { omitted: ["page_limit", "page_limit"] },
    { claims: [claim, claim], count: 2 },
    { claims: [{ ...claim, source_seq: 0 }] },
    { claims: [{ ...claim, version: 0 }] },
    { claims: [{ ...claim, workshop_id: "PRIVATE" }] },
  ])
    expect(
      ClaimsListResponseSchema.safeParse({ ...valid, ...patch }).success,
      JSON.stringify(patch),
    ).toBe(false);
});

test("public schema exposes both query and response from the canonical contract", () => {
  const schema = JSON.parse(generateClaimsListSchema());
  expect(schema.$id).toBe(CLAIMS_LIST_SCHEMA_ID);
  expect(Object.keys(schema.properties)).toEqual(["query", "response"]);
  expect(schema.properties.query.additionalProperties).toBe(false);
  expect(schema.properties.query.properties.through.type).toBe("string");
  expect(schema.properties.response.properties.claims.maxItems).toBe(8);
  expect(schema.properties.response.properties.claims.items.additionalProperties).toBe(false);
});
