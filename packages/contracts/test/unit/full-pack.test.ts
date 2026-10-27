import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { FullPackPageSchema, FullPackQuerySchema } from "../../src/sessions.ts";

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(new URL(path, import.meta.url)).text()) as unknown;
}

test("full pack query and page fixtures share generated JSON Schema structural constraints", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema((await fixture("../../generated/sessions.schema.json")) as object, "sessions");
  for (const [name, schema] of [
    ["full-pack-query", FullPackQuerySchema],
    ["full-pack-page", FullPackPageSchema],
  ] as const) {
    const validate = ajv.compile({ $ref: `sessions#/properties/${name.replaceAll("-", "_")}` });
    for (const [directory, expected] of [
      ["valid", true],
      ["invalid", false],
    ] as const) {
      const value = await fixture(`../fixtures/${directory}/${name}.json`);
      expect(schema.safeParse(value).success).toBe(expected);
      expect(validate(value)).toBe(expected);
    }
  }
});

test("full pack continuations require a frozen window and advance exactly the represented prefix", () => {
  expect(FullPackQuerySchema.parse({ profile: "full" })).toEqual({ profile: "full", after: 0 });
  for (const value of [
    { profile: "full", after: 1 },
    { profile: "full", after: 4, through: 3 },
    { profile: "full", after: 0, through: Number.MAX_SAFE_INTEGER + 1 },
    { profile: "full", after: 0, through: 3, since: 0 },
  ])
    expect(FullPackQuerySchema.safeParse(value).success).toBe(false);
  const page = {
    control: "full_pack_page",
    after: 2,
    through: 9,
    next_after: 4,
    has_more: true,
    records: 2,
  };
  expect(FullPackPageSchema.safeParse(page).success).toBe(true);
  for (const value of [
    { ...page, records: 0, next_after: 2 },
    { ...page, next_after: 5 },
    { ...page, has_more: false, next_after: null },
    { ...page, through: 3 },
    { ...page, after: Number.MAX_SAFE_INTEGER, through: Number.MAX_SAFE_INTEGER },
  ])
    expect(FullPackPageSchema.safeParse(value).success).toBe(false);
  expect(
    FullPackPageSchema.safeParse({
      control: "full_pack_page",
      after: 9,
      through: 9,
      next_after: null,
      has_more: false,
      records: 0,
    }).success,
  ).toBe(true);
});
