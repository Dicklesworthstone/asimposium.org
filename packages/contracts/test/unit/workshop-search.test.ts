import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  generateWorkshopSearchSchema,
  WORKSHOP_SEARCH_PAGE_LIMIT,
  WORKSHOP_SEARCH_SCHEMA_ID,
  WorkshopSearchItemSchema,
  WorkshopSearchRequestSchema,
  WorkshopSearchResponseSchema,
  workshopSearchPageIsValid,
  workshopSearchTerms,
} from "../../src/workshop-search.ts";

async function fixture(path: string) {
  return JSON.parse(await Bun.file(new URL(path, import.meta.url)).text());
}

test("private search's served schema and Zod enforce bounded strict contracts", async () => {
  const generated = JSON.parse(generateWorkshopSearchSchema());
  expect(generated.$id).toBe(WORKSHOP_SEARCH_SCHEMA_ID);
  expect(generated.additionalProperties).toBe(false);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(generated, "private-search");
  for (const [root, schema, valid, invalid] of [
    [
      "request",
      WorkshopSearchRequestSchema,
      "workshop-search-request",
      "workshop-search-request-authority",
    ],
    [
      "response",
      WorkshopSearchResponseSchema,
      "workshop-search-response",
      "workshop-search-response-private-body",
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `private-search#/properties/${root}` });
    for (const [directory, name, accepted] of [
      ["valid", valid, true],
      ["invalid", invalid, false],
    ] as const) {
      const value = await fixture(`../fixtures/${directory}/${name}.json`);
      expect(schema.safeParse(value).success).toBe(accepted);
      expect(validate(value)).toBe(accepted);
    }
  }
});

test("queries accept literal international words and reject unbounded or ambiguous commands", () => {
  expect(workshopSearchTerms('"finite" OR title:路径*')).toEqual(["finite", "OR", "title", "路径"]);
  expect(workshopSearchTerms("finite finite path")).toEqual(["finite", "path"]);
  expect(WorkshopSearchRequestSchema.parse({ query: "  finite path  " })).toEqual({
    query: "finite path",
  });
  for (const query of [
    "",
    "   ",
    "***",
    "\u0000path",
    "finite\npath",
    "a".repeat(65),
    "a b c d e f g h i",
    "a ".repeat(81),
  ])
    expect(WorkshopSearchRequestSchema.safeParse({ query }).success).toBe(false);
  for (const extra of [
    { limit: 100 },
    { after: "../private" },
    { offset: 1 },
    { state: "all" },
    { problem_id: "../secret" },
  ])
    expect(WorkshopSearchRequestSchema.safeParse({ query: "finite", ...extra }).success).toBe(
      false,
    );
});

test("response cursor and filters remain bound to the exact ordered result page", async () => {
  const seed = WorkshopSearchResponseSchema.parse(
    await fixture("../fixtures/valid/workshop-search-response.json"),
  );
  const item = WorkshopSearchItemSchema.parse(seed.items[0]);
  const items = Array.from({ length: WORKSHOP_SEARCH_PAGE_LIMIT }, (_, i) => ({
    ...item,
    workshop_id: `W-${String(i + 2).padStart(26, "0")}`,
  }));
  const last = WorkshopSearchItemSchema.parse(items.at(-1));
  const page = { ...seed, items, next_cursor: last.workshop_id };
  const request = WorkshopSearchRequestSchema.parse(
    await fixture("../fixtures/valid/workshop-search-request.json"),
  );
  expect(workshopSearchPageIsValid(page, request)).toBe(true);
  for (const bad of [
    { ...page, query: "other" },
    { ...page, next_cursor: item.workshop_id },
    { ...page, items: items.slice(1) },
    { ...page, items: [...items].reverse() },
    { ...page, items: [{ ...item, fellow_id: "other-fellow" }], next_cursor: null },
    { ...page, items: [{ ...item, problem_id: "P-OTHER" }], next_cursor: null },
    { ...page, items: [{ ...item, state: "discarded" as const }], next_cursor: null },
    { ...page, items: [item, item], next_cursor: null },
  ])
    expect(workshopSearchPageIsValid(bad, request)).toBe(false);
  expect(workshopSearchPageIsValid(page, { ...request, after: page.next_cursor })).toBe(false);
  for (const invalid of [
    { ...seed, items: [...items, item] },
    { ...seed, items: [{ ...item, version: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...seed, items: [{ ...item, excerpt: "x".repeat(281) }] },
    { ...seed, items: [{ ...item, body_coverage: "full-CAS-body" }] },
    { ...seed, total_count: 1 },
    { ...seed, items: [{ ...item, score: 0.8 }] },
  ])
    expect(WorkshopSearchResponseSchema.safeParse(invalid).success).toBe(false);
});
