import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  generateSponsorDataExportSchema,
  SponsorDataExportPageRequestSchema,
  SponsorDataExportPageResponseSchema,
} from "../../src/account-export.ts";

const fixture = (kind: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${kind}/account-export-page.json`, import.meta.url), "utf8"),
  );

test("a complete secret-free export page validates and private authority fields do not", () => {
  expect(SponsorDataExportPageResponseSchema.safeParse(fixture("valid")).success).toBe(true);
  expect(SponsorDataExportPageResponseSchema.safeParse(fixture("invalid")).success).toBe(false);
  expect(SponsorDataExportPageRequestSchema.safeParse({}).success).toBe(true);
  expect(SponsorDataExportPageRequestSchema.safeParse({ sponsor_id: "usr_other" }).success).toBe(
    false,
  );
  expect(
    SponsorDataExportPageRequestSchema.safeParse({ cursor: fixture("valid").next_cursor }).success,
  ).toBe(true);
});

test("continuations cannot mix revisions or return a record from another section", () => {
  const page = fixture("valid");
  expect(
    SponsorDataExportPageResponseSchema.safeParse({
      ...page,
      next_cursor: { ...page.next_cursor, snapshot: { ...page.snapshot, revision: 8 } },
    }).success,
  ).toBe(false);
  expect(
    SponsorDataExportPageResponseSchema.safeParse({ ...page, section: "fellows" }).success,
  ).toBe(false);
  expect(
    SponsorDataExportPageRequestSchema.safeParse({
      cursor: { ...page.next_cursor, after: -1 },
    }).success,
  ).toBe(false);
});

test("the public schema is generated from the same strict private contract", () => {
  const doc = JSON.parse(generateSponsorDataExportSchema());
  expect(doc.$id).toBe("https://a.asimposium.org/schemas/account-export.v1.json");
  expect(doc.additionalProperties).toBe(false);
  expect(doc.properties.request.additionalProperties).toBe(false);
  expect(doc.properties.response.properties.records.maxItems).toBe(20);
});
