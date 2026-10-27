import { expect, test } from "bun:test";
import {
  WORKSHOP_SEARCH_SCHEMA,
  WorkshopSearchItemSchema,
  type WorkshopSearchRequest,
  type WorkshopSearchResponse,
} from "@asimposium/contracts/workshop-search";
import { searchOwnedWorkshops, workshopSearchResultHref } from "../../lib/workshop-search";

const response: WorkshopSearchResponse = {
  schema: WORKSHOP_SEARCH_SCHEMA,
  sponsor_id: "usr_own",
  query: "finite endpoint",
  coverage: "titles-and-stored-draft-text",
  items: [
    {
      workshop_id: "W-00000000000000000000000001",
      fellow_id: "fellow-private",
      problem_id: "P-OWN",
      type: "scratch",
      title: "Private finite endpoint notes",
      excerpt: "PRIVATE_SEARCH_CANARY",
      body_coverage: "inline-body",
      version: 3,
      workshop_seq: 7,
      state: "open",
    },
  ],
  next_cursor: null,
};

test("search action authenticates and validates before signing a private read", async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { ok: true as const, data: response };
  };
  for (const sponsor of [undefined, null, "", "user@email.invalid"])
    expect((await searchOwnedWorkshops(sponsor, { query: "finite endpoint" }, read)).ok).toBe(
      false,
    );
  for (const input of [
    null,
    {},
    { query: "*" },
    { query: "finite", sponsor_id: "usr_other" },
    { query: "finite", limit: 100 },
  ])
    expect((await searchOwnedWorkshops("usr_own", input, read)).ok).toBe(false);
  expect(reads).toBe(0);
  const calls: unknown[] = [];
  const result = await searchOwnedWorkshops(
    "usr_own",
    { query: "  finite endpoint " },
    async (sponsor, request) => {
      calls.push({ sponsor, request });
      return { ok: true, data: response };
    },
  );
  expect(calls).toEqual([{ sponsor: "usr_own", request: { query: "finite endpoint" } }]);
  expect(result).toEqual({ ok: true, request: { query: "finite endpoint" }, page: response });
});

test("stale, foreign or misbound result pages never release excerpts through the Server Action", async () => {
  const base: WorkshopSearchRequest = { query: "finite endpoint" };
  const item = WorkshopSearchItemSchema.parse(response.items[0]);
  for (const [request, data] of [
    [base, { ...response, sponsor_id: "usr_other" }],
    [base, { ...response, query: "other private query" }],
    [base, { ...response, items: [item, item] }],
    [base, { ...response, next_cursor: item.workshop_id }],
    [{ ...base, fellow_id: "fellow-other" }, response],
    [{ ...base, problem_id: "P-OTHER" }, response],
    [{ ...base, state: "discarded" as const }, response],
    [{ ...base, after: item.workshop_id }, response],
  ] satisfies [WorkshopSearchRequest, WorkshopSearchResponse][]) {
    const result = await searchOwnedWorkshops("usr_own", request, async () => ({ ok: true, data }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SEARCH_CANARY");
    expect(JSON.stringify(result)).not.toContain("other private query");
  }
  const failed = await searchOwnedWorkshops("usr_own", base, async () => {
    throw new Error("PRIVATE_UPSTREAM_ERROR");
  });
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_UPSTREAM_ERROR");
});

test("result links point to the exact draft page without embedding search or excerpt text", () => {
  const item = WorkshopSearchItemSchema.parse(response.items[0]);
  const href = workshopSearchResultHref(item);
  expect(href).toBe(
    `/console/workshop/fellow-private/P-OWN?before_workshop_seq=8#${item.workshop_id}`,
  );
  expect(href).not.toContain(response.query);
  expect(href).not.toContain(item.excerpt);
  const encoded = new URL(
    workshopSearchResultHref({ ...item, fellow_id: "fellow/<script>" }),
    "https://asimposium.org",
  );
  expect(encoded.origin).toBe("https://asimposium.org");
  expect(encoded.pathname).toBe("/console/workshop/fellow%2F%3Cscript%3E/P-OWN");
});
