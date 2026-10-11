import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  compareSponsorWorkshopIndexCursors,
  SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT,
  SponsorWorkshopIndexRequestSchema,
  SponsorWorkshopIndexResponseSchema,
  sponsorWorkshopIndexPageIsValid,
} from "../../src/sessions.ts";

async function fixture(path: string) {
  return JSON.parse(await Bun.file(new URL(path, import.meta.url)).text());
}

test("directory wire contracts are bounded and exclude authority and private bodies", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(await fixture("../../generated/sessions.schema.json"), "sessions");
  for (const [root, schema, validName, invalidName] of [
    [
      "sponsor_workshop_index_request",
      SponsorWorkshopIndexRequestSchema,
      "sponsor-workshop-index-request",
      "sponsor-workshop-index-request-authority",
    ],
    [
      "sponsor_workshop_index_response",
      SponsorWorkshopIndexResponseSchema,
      "sponsor-workshop-index-response",
      "sponsor-workshop-index-response-private-body",
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `sessions#/properties/${root}` });
    const valid = await fixture(`../fixtures/valid/${validName}.json`);
    const invalid = await fixture(`../fixtures/invalid/${invalidName}.json`);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(validate(valid)).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  }
  const page = await fixture("../fixtures/valid/sponsor-workshop-index-response.json");
  for (const bad of [
    {
      ...page,
      workshops: Array.from(
        { length: SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT + 1 },
        () => page.workshops[0],
      ),
    },
    {
      ...page,
      workshops: [{ ...page.workshops[0], workshop_cursor: Number.MAX_SAFE_INTEGER + 1 }],
    },
    { ...page, next_cursor: { fellow_id: "fellow-a", problem_id: "../private" } },
  ])
    expect(SponsorWorkshopIndexResponseSchema.safeParse(bad).success).toBe(false);
  for (const bad of [
    null,
    [],
    { after: null },
    { after: { fellow_id: "fellow-a" } },
    { after: { fellow_id: "fellow-a", problem_id: "P-4DSP", offset: 20 } },
  ])
    expect(SponsorWorkshopIndexRequestSchema.safeParse(bad).success).toBe(false);
  expect(SponsorWorkshopIndexRequestSchema.parse({})).toEqual({});
});

test("directory pagination is strictly ordered and the cursor is the last emitted pair", () => {
  const workshops = Array.from({ length: SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT }, (_, i) => ({
    fellow_id: "fellow-a",
    fellow_name: "redshift",
    problem_id: `P-${String(i).padStart(3, "0")}`,
    workshop_cursor: 1,
  }));
  const last = workshops.at(-1)!;
  const page = SponsorWorkshopIndexResponseSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    sponsor_id: "usr_test",
    workshops,
    next_cursor: { fellow_id: last.fellow_id, problem_id: last.problem_id },
  });
  expect(sponsorWorkshopIndexPageIsValid(page, {})).toBe(true);
  expect(sponsorWorkshopIndexPageIsValid({ ...page, next_cursor: null }, {})).toBe(true);
  expect(sponsorWorkshopIndexPageIsValid(page, { after: page.next_cursor! })).toBe(false);
  expect(sponsorWorkshopIndexPageIsValid({ ...page, workshops: workshops.slice(1) }, {})).toBe(
    false,
  );
  expect(
    sponsorWorkshopIndexPageIsValid({ ...page, workshops: [...workshops].reverse() }, {}),
  ).toBe(false);
  expect(
    sponsorWorkshopIndexPageIsValid(
      { ...page, workshops: [workshops[0]!, workshops[0]!], next_cursor: null },
      {},
    ),
  ).toBe(false);
  expect(
    sponsorWorkshopIndexPageIsValid(
      { ...page, next_cursor: { fellow_id: "fellow-z", problem_id: "P-999" } },
      {},
    ),
  ).toBe(false);
  expect(
    compareSponsorWorkshopIndexCursors(
      { fellow_id: "fellow-\uE000", problem_id: "P-AAA" },
      { fellow_id: "fellow-😀", problem_id: "P-AAA" },
    ),
  ).toBeLessThan(0);
});
