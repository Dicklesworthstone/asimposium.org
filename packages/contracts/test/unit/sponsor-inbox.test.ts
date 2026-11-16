import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SPONSOR_INBOX_DEFAULT_LIMIT,
  SPONSOR_INBOX_PAGE_LIMIT,
  SponsorInboxRequestSchema,
  SponsorInboxResponseSchema,
  SponsorInboxSourceRefSchema,
  sponsorInboxPageIsValid,
} from "../../src/inbox.ts";

async function fixture(path: string) {
  return JSON.parse(await Bun.file(new URL(path, import.meta.url)).text());
}

test("sponsor feedback carries only bounded distinct exact publication references", async () => {
  const page = await fixture("../fixtures/valid/sponsor-inbox-response.json");
  const item = {
    ...page.items[0],
    type: "object_critique",
    problem_id: "P-DEMO",
    target_id: "Q-ANSWER",
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(await fixture("../../generated/inbox.schema.json"), "inbox");
  const validate = ajv.compile({ $ref: "inbox#/properties/sponsor_inbox_response" });
  for (const source_refs of [["C-7@3"], ["E-ABC"], ["R-ABC"], ["E-ABC", "R-ABC"]]) {
    const response = { ...page, items: [{ ...item, source_refs }] };
    expect(SponsorInboxResponseSchema.safeParse(response).success).toBe(true);
    expect(validate(response)).toBe(true);
  }
  for (const fields of [
    { source_refs: [] },
    { source_refs: ["E-ABC", "E-ABC"] },
    { source_refs: ["C-1@1", "E-ABC", "R-ABC"] },
    { source_refs: ["https://evil.invalid"] },
    { source_refs: ["/v1/inbox/ack"] },
    { source_refs: ["C-7"] },
    { source_refs: ["C-7@0"] },
    { source_refs: ["C-07@1"] },
    { source_refs: ["R-ABC\n"] },
    { source_refs: ["E-ABC@1"] },
    { source_refs: ["E-ABC?x=1"] },
    { source_refs: ["E-ABC"], type: "sponsor_directive" },
    { source_refs: ["E-ABC"], problem_id: null },
    { source_refs: ["E-ABC"], problem_id: "P-DEMO\n" },
    { source_refs: ["E-ABC"], next_actions: [] },
  ]) {
    const response = { ...page, items: [{ ...item, ...fields }] };
    expect(SponsorInboxResponseSchema.safeParse(response).success).toBe(false);
    expect(validate(response)).toBe(false);
  }
  for (const reference of ["C-9007199254740992@1", "C-1@9007199254740992", "E-ABC/../../secret"])
    expect(SponsorInboxSourceRefSchema.safeParse(reference).success).toBe(false);
  expect(SponsorInboxSourceRefSchema.safeParse("C-9007199254740991@9007199254740991").success).toBe(
    true,
  );
});

test("signed sponsor inbox contracts exclude injected authority and Fellow commands", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(await fixture("../../generated/inbox.schema.json"), "inbox");
  for (const [root, schema, validName, invalidName] of [
    [
      "sponsor_inbox_request",
      SponsorInboxRequestSchema,
      "sponsor-inbox-request",
      "sponsor-inbox-request-authority",
    ],
    [
      "sponsor_inbox_response",
      SponsorInboxResponseSchema,
      "sponsor-inbox-response",
      "sponsor-inbox-response-agent-action",
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `inbox#/properties/${root}` });
    const valid = await fixture(`../fixtures/valid/${validName}.json`);
    const invalid = await fixture(`../fixtures/invalid/${invalidName}.json`);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(validate(valid)).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  }
  const defaultRequest = { fellow_id: "fellow-01JXYZ" };
  expect(SponsorInboxRequestSchema.parse(defaultRequest)).toEqual({
    ...defaultRequest,
    limit: SPONSOR_INBOX_DEFAULT_LIMIT,
  });
  expect(ajv.compile({ $ref: "inbox#/properties/sponsor_inbox_request" })(defaultRequest)).toBe(
    true,
  );
});

test("inbox pages and numeric fields are bounded without coercing malformed requests", async () => {
  const page = await fixture("../fixtures/valid/sponsor-inbox-response.json");
  for (const value of [
    { fellow_id: "" },
    { fellow_id: "fellow\0other" },
    { fellow_id: page.fellow_id, limit: 0 },
    { fellow_id: page.fellow_id, limit: SPONSOR_INBOX_PAGE_LIMIT + 1 },
    { fellow_id: page.fellow_id, since: Number.MAX_SAFE_INTEGER + 1 },
    { fellow_id: page.fellow_id, since: "7" },
    { fellow_id: page.fellow_id, unacknowledged_only: "true" },
    { fellow_id: page.fellow_id, until_seq: 7 },
  ])
    expect(SponsorInboxRequestSchema.safeParse(value).success).toBe(false);
  for (const value of [
    { ...page, items: Array.from({ length: SPONSOR_INBOX_PAGE_LIMIT + 1 }, () => page.items[0]) },
    { ...page, items: [{ ...page.items[0], seq: 0 }] },
    { ...page, items: [{ ...page.items[0], created_at: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...page, items: [{ ...page.items[0], acknowledged_at: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...page, next_cursor: Number.MAX_SAFE_INTEGER + 1 },
    { ...page, fellow_unacknowledged_count: Number.MAX_SAFE_INTEGER + 1 },
    { ...page, sponsor_id: "person@example.com" },
  ])
    expect(SponsorInboxResponseSchema.safeParse(value).success).toBe(false);
});

test("continuations preserve chronological delivery, exact scope and Fellow acknowledgement", async () => {
  const page = SponsorInboxResponseSchema.parse(
    await fixture("../fixtures/valid/sponsor-inbox-response.json"),
  );
  const request = SponsorInboxRequestSchema.parse(
    await fixture("../fixtures/valid/sponsor-inbox-request.json"),
  );
  const [first, second] = page.items;
  if (first === undefined || second === undefined)
    throw new Error("Inbox fixture needs two notices");
  expect(sponsorInboxPageIsValid(page, request)).toBe(true);
  expect(sponsorInboxPageIsValid({ ...page, has_more: false }, request)).toBe(true);
  for (const invalid of [
    { ...page, fellow_id: "fellow-another" },
    { ...page, items: [...page.items].reverse() },
    { ...page, items: [first, first] },
    { ...page, items: [first, { ...second, id: first.id }] },
    { ...page, next_cursor: 9 },
    { ...page, next_cursor: null },
    { ...page, items: page.items.slice(1) },
  ])
    expect(sponsorInboxPageIsValid(invalid, request)).toBe(false);
  expect(sponsorInboxPageIsValid(page, { ...request, since: 7 })).toBe(false);
  expect(sponsorInboxPageIsValid(page, { ...request, limit: 1 })).toBe(false);
  expect(sponsorInboxPageIsValid(page, { ...request, unacknowledged_only: true })).toBe(false);
  expect(
    sponsorInboxPageIsValid(
      {
        ...page,
        items: [],
        next_cursor: null,
        has_more: false,
      },
      { ...request, since: 8 },
    ),
  ).toBe(true);
});
