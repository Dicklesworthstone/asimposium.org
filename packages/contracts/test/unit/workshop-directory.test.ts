import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { ContractProblemSchema } from "../../src/index.ts";
import {
  generateWorkshopDirectorySchema,
  WORKSHOP_DIRECTORY_SCHEMA_ID,
  WorkshopDirectoryQuerySchema,
  WorkshopDirectoryResponseSchema,
  workshopDirectoryMatchesQuery,
  workshopDirectoryPath,
} from "../../src/workshop-directory.ts";

async function fixture(path: string) {
  return JSON.parse(await Bun.file(new URL(path, import.meta.url)).text());
}

test("workshop directory Zod and generated schema agree on valid and private-body/authority fixtures", async () => {
  const generated = JSON.parse(generateWorkshopDirectorySchema());
  expect(generated.$id).toBe(WORKSHOP_DIRECTORY_SCHEMA_ID);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(generated, "directory");
  for (const [part, schema, valid, invalid] of [
    [
      "query",
      WorkshopDirectoryQuerySchema,
      "workshop-directory-query",
      "workshop-directory-query-authority",
    ],
    [
      "response",
      WorkshopDirectoryResponseSchema,
      "workshop-directory-response",
      "workshop-directory-response-private-body",
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `directory#/properties/${part}` });
    for (const [directory, name, accepted] of [
      ["valid", valid, true],
      ["invalid", invalid, false],
    ] as const) {
      const value = await fixture(`../fixtures/${directory}/${name}.json`);
      expect(schema.safeParse(value).success).toBe(accepted);
      expect(validate(value)).toBe(accepted);
    }
  }
  const validateQuery = ajv.compile({ $ref: "directory#/properties/query" });
  for (const value of [
    { limit: "0" },
    { limit: "101" },
    { limit: "1.0" },
    { limit: "01" },
    { limit: "2\n" },
    { limit: 2 },
    { after: "W-00000000000000000000000002\n" },
    { state: "all" },
    { problem_id: "P-4DSP" },
  ]) {
    expect(WorkshopDirectoryQuerySchema.safeParse(value).success).toBe(false);
    expect(validateQuery(value)).toBe(false);
  }
  expect(WorkshopDirectoryQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
  expect(
    ContractProblemSchema.parse(
      await fixture("../fixtures/valid/workshop-directory-schema-invalid.json"),
    ).code,
  ).toBe("SCHEMA_INVALID");
});

test("directory page binds identity, state, cursor and immutable revision links", async () => {
  const page = WorkshopDirectoryResponseSchema.parse(
    await fixture("../fixtures/valid/workshop-directory-response.json"),
  );
  const query = WorkshopDirectoryQuerySchema.parse(
    await fixture("../fixtures/valid/workshop-directory-query.json"),
  );
  expect(
    workshopDirectoryMatchesQuery(page.session_id, page.problem_id, page.fellow_id, query, page),
  ).toBe(true);
  expect(workshopDirectoryPath(page.session_id, query)).toBe(
    `/v1/sessions/${page.session_id}/workshop?after=${page.after}&limit=2&state=open`,
  );
  for (const bad of [
    { ...page, session_id: "S-00000000000000000000000003" },
    { ...page, problem_id: "P-OTHER" },
    { ...page, fellow_id: "other" },
    { ...page, after: null },
    { ...page, state: null },
  ])
    expect(
      workshopDirectoryMatchesQuery(page.session_id, page.problem_id, page.fellow_id, query, bad),
    ).toBe(false);
  const item = page.items[0]!;
  for (const bad of [
    { ...page, items: [item, item] },
    { ...page, next_after: page.after, omitted: ["page_limit"] },
    { ...page, next_after: page.scanned_through },
    { ...page, omitted: ["page_limit"] },
    { ...page, items: [{ ...item, state: "archived" }] },
    { ...page, items: [{ ...item, read_url: item.read_url.replace("version=2", "version=1") }] },
    { ...page, items: [], omitted: [] },
    { ...page, items: [{ ...item, cas_hash: "private-storage-key" }] },
  ])
    expect(WorkshopDirectoryResponseSchema.safeParse(bad).success).toBe(false);
  expect(
    WorkshopDirectoryResponseSchema.safeParse({
      ...page,
      items: [],
      next_after: page.scanned_through,
      omitted: ["source_unavailable", "page_limit"],
    }).success,
  ).toBe(true);
});
