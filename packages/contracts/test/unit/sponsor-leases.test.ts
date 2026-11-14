import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SPONSOR_LEASE_LIST_PAGE_LIMIT,
  SponsorLeaseListRequestSchema,
  SponsorLeaseListResponseSchema,
  SponsorLeaseSummarySchema,
  sponsorLeaseListPageIsValid,
} from "../../src/leases.ts";

async function fixture(name: string) {
  return JSON.parse(await Bun.file(new URL(`../fixtures/${name}.json`, import.meta.url)).text());
}

test("Zod and the served schema accept bounded lease pages and reject client authority or private text", async () => {
  const generated = JSON.parse(
    await Bun.file(new URL("../../generated/sessions.schema.json", import.meta.url)).text(),
  );
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const [root, schema, valid, invalid] of [
    [
      "sponsor_lease_list_request",
      SponsorLeaseListRequestSchema,
      "sponsor-lease-list-request",
      "sponsor-lease-list-authority",
    ],
    [
      "sponsor_lease_list_response",
      SponsorLeaseListResponseSchema,
      "sponsor-lease-list-response",
      "sponsor-lease-list-private-text",
    ],
  ] as const) {
    const validate = ajv.compile(generated.properties[root]);
    for (const [name, accepted] of [
      [`valid/${valid}`, true],
      [`invalid/${invalid}`, false],
    ] as const) {
      const value = await fixture(name);
      expect(schema.safeParse(value).success).toBe(accepted);
      expect(validate(value)).toBe(accepted);
    }
  }
});

test("only immutable canonical lease IDs can select a page", () => {
  expect(SponsorLeaseListRequestSchema.parse({})).toEqual({});
  for (const value of [
    null,
    [],
    { after: "C-12" },
    { after: ["L-1"] },
    { limit: 100 },
    { after: "../private" },
  ])
    expect(SponsorLeaseListRequestSchema.safeParse(value).success).toBe(false);
});

test("cursor continuity rejects reordered, duplicate, oversized and falsely truncated lease pages", async () => {
  const seed = SponsorLeaseListResponseSchema.parse(
    await fixture("valid/sponsor-lease-list-response"),
  );
  const item = SponsorLeaseSummarySchema.parse(seed.leases[0]);
  const leases = Array.from({ length: SPONSOR_LEASE_LIST_PAGE_LIMIT }, (_, index) => ({
    ...item,
    lease_id: `L-${String(index + 2).padStart(26, "0")}`,
  }));
  const page = { ...seed, leases, next_cursor: leases.at(-1)?.lease_id ?? null };
  expect(sponsorLeaseListPageIsValid(page, {})).toBe(true);
  for (const bad of [
    { ...page, next_cursor: item.lease_id },
    { ...page, leases: leases.slice(1) },
    { ...page, leases: [...leases].reverse() },
    { ...page, leases: [item, item], next_cursor: null },
  ])
    expect(sponsorLeaseListPageIsValid(bad, {})).toBe(false);
  expect(sponsorLeaseListPageIsValid(page, { after: page.next_cursor ?? undefined })).toBe(false);
  expect(
    SponsorLeaseListResponseSchema.safeParse({ ...page, leases: [...leases, item] }).success,
  ).toBe(false);
  expect(
    SponsorLeaseListResponseSchema.safeParse({ ...seed, leases: [{ ...item, status: "released" }] })
      .success,
  ).toBe(false);
});
