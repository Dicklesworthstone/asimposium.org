import { expect, test } from "bun:test";
import {
  EvidenceListResponseSchema,
  evidenceListPath,
  generateResearchListsSchema,
  RESEARCH_LISTS_SCHEMA_ID,
  ResearchListQuerySchema,
  ReviewListResponseSchema,
  researchListMatchesQuery,
  reviewsListPath,
} from "../../src/research-lists.ts";
import fixtures from "../fixtures/research-lists.json";

const { evidence: evidenceFixture, reviews: reviewsFixture, query: queryFixture } = fixtures.valid;
const {
  evidence: invalidEvidence,
  reviews: invalidReviews,
  query: invalidQuery,
} = fixtures.invalid;

test("research directory fixtures preserve exact targets, attribution and recorded tiers", () => {
  const evidence = EvidenceListResponseSchema.parse(evidenceFixture);
  const reviews = ReviewListResponseSchema.parse(reviewsFixture);
  expect(evidence.evidence[0]?.bears_on).toEqual({ kind: "claim", id: "C-1", version: 1 });
  expect(evidence.evidence[1]?.bears_on).toEqual({ kind: "hypothesis", id: "H-1" });
  expect(evidence.evidence[1]?.publication.sponsor_id).toBeNull();
  expect(reviews.reviews.map((entry) => entry.independence_tier)).toEqual([2, null]);
  expect(EvidenceListResponseSchema.safeParse(invalidEvidence).success).toBe(false);
  expect(ReviewListResponseSchema.safeParse(invalidReviews).success).toBe(false);
});

test("continuations retain one cut and reject ambiguous or unsupported input", () => {
  expect(invalidQuery.expected_code).toBe("CURSOR_INVALID");
  expect(ResearchListQuerySchema.parse(queryFixture)).toEqual({ through: 40, after: 20 });
  expect(ResearchListQuerySchema.parse({ through: "0", after: "0" })).toEqual({
    through: 0,
    after: 0,
  });
  for (const query of [
    invalidQuery.input,
    { after: "0" },
    { through: "040" },
    { through: "-1" },
    { through: "9007199254740992" },
    { through: "2", after: "3" },
    { through: "2\n" },
    { through: ["2", "2"] },
    { through: 2 },
    { limit: "200" },
    { format: "toon" },
  ])
    expect(ResearchListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
  expect(evidenceListPath("P-RESEARCH", "human", { through: 40, after: 20 })).toBe(
    "/p/P-RESEARCH/evidence?through=40&after=20",
  );
  expect(reviewsListPath("P-RESEARCH", "md", { through: 40, after: 20 })).toBe(
    "/p/P-RESEARCH/reviews.md?through=40&after=20",
  );
  expect(reviewsListPath("P-RESEARCH", "json")).toBe("/p/P-RESEARCH/reviews.json");
});

test("empty withheld pages can progress while impossible ranges and duplicate publications fail", () => {
  for (const [schema, fixture, key] of [
    [EvidenceListResponseSchema, evidenceFixture, "evidence"],
    [ReviewListResponseSchema, reviewsFixture, "reviews"],
  ] as const) {
    expect(schema.safeParse({ ...fixture, [key]: [], count: 0 }).success).toBe(true);
    for (const patch of [
      { count: 0 },
      { scanned_through: 41 },
      { after: 21 },
      { scanned_through: 10 },
      { next_after: 0 },
      { next_after: 19 },
      { next_after: null },
      { omitted: ["content_unavailable"] },
      { omitted: ["page_limit", "page_limit"] },
      { workshop: "PRIVATE" },
    ])
      expect(schema.safeParse({ ...fixture, ...patch }).success, JSON.stringify(patch)).toBe(false);
  }
  const evidence = evidenceFixture.evidence[0];
  const review = reviewsFixture.reviews[0];
  if (!evidence || !review) throw new Error("Fixtures must have source publications");
  expect(
    EvidenceListResponseSchema.safeParse({
      ...evidenceFixture,
      evidence: [evidence, evidence],
    }).success,
  ).toBe(false);
  expect(
    ReviewListResponseSchema.safeParse({
      ...reviewsFixture,
      reviews: [review, review],
    }).success,
  ).toBe(false);
});

test("exact claim filters stay bound to matching publications and every continuation", () => {
  expect(fixtures.invalid.target_query.expected_code).toBe("CURSOR_INVALID");
  expect(ResearchListQuerySchema.parse(fixtures.valid.target_query)).toEqual({
    through: 40,
    after: 20,
    target: "C-1@1",
  });
  for (const target of [
    "C-1",
    "H-1",
    "C-1@0",
    "C-1@01",
    "C-1@-1",
    "C-1@1@2",
    "C-1@9007199254740992",
    "C-1@1\n",
    "C-1@1&through=0",
    ["C-1@1", "C-2@1"],
  ])
    expect(ResearchListQuerySchema.safeParse({ target }).success, JSON.stringify(target)).toBe(
      false,
    );
  const evidence = EvidenceListResponseSchema.parse({
    ...evidenceFixture,
    target: "C-1@1",
    evidence: [evidenceFixture.evidence[0]],
    count: 1,
  });
  const reviews = ReviewListResponseSchema.parse({ ...reviewsFixture, target: "C-1@1" });
  for (const [schema, face] of [
    [EvidenceListResponseSchema, evidence],
    [ReviewListResponseSchema, reviews],
  ] as const) {
    expect(schema.safeParse({ ...face, target: "C-1@2" }).success).toBe(false);
    expect(schema.safeParse({ ...face, target: "C-2@1" }).success).toBe(false);
    expect(researchListMatchesQuery("P-RESEARCH", { through: 40, target: "C-1@1" }, face)).toBe(
      true,
    );
    expect(researchListMatchesQuery("P-RESEARCH", { through: 40 }, face)).toBe(false);
    expect(researchListMatchesQuery("P-RESEARCH", { through: 40, target: "C-1@2" }, face)).toBe(
      false,
    );
  }
  expect(
    EvidenceListResponseSchema.safeParse({ ...evidenceFixture, target: "C-1@1" }).success,
  ).toBe(false);
  expect(
    researchListMatchesQuery(
      "P-RESEARCH",
      { target: "C-1@1" },
      EvidenceListResponseSchema.parse(evidenceFixture),
    ),
  ).toBe(false);
  for (const path of [evidenceListPath, reviewsListPath])
    expect(path("P-RESEARCH", "json", { through: 40, after: 20, target: "C-1@1" })).toEndWith(
      "?through=40&after=20&target=C-1%401",
    );
});

test("collection sources cannot be rebound to another problem or private target", () => {
  const evidence = evidenceFixture.evidence[0];
  const review = reviewsFixture.reviews[0];
  if (!evidence || !review) throw new Error("Fixtures must have source publications");
  for (const patch of [
    { read_url: "/p/P-OTHER/evidence/E-1.json" },
    { read_url: "/p/P-RESEARCH/evidence/E-1.json?through=40" },
    { read_url: "https://untrusted.invalid/source" },
    { bears_on: { kind: "hypothesis", id: "H-1", version: 1 } },
    { bears_on: { kind: "workshop", id: "W-PRIVATE" } },
    { publication: { ...evidence.publication, payload_sha256: "not-a-hash" } },
    { publication: { ...evidence.publication, seq: 41 } },
    { publication: { ...evidence.publication, email: "private@example.invalid" } },
  ])
    expect(
      EvidenceListResponseSchema.safeParse({
        ...evidenceFixture,
        count: 1,
        evidence: [{ ...evidence, ...patch }],
      }).success,
      JSON.stringify(patch),
    ).toBe(false);
  for (const tier of [-1, 4, "T2", "unknown"])
    expect(
      ReviewListResponseSchema.safeParse({
        ...reviewsFixture,
        count: 1,
        reviews: [{ ...review, independence_tier: tier }],
      }).success,
    ).toBe(false);
});

test("upstream faces bind to the requested problem, snapshot and continuation", () => {
  const face = EvidenceListResponseSchema.parse(evidenceFixture);
  expect(researchListMatchesQuery("P-RESEARCH", {}, face)).toBe(true);
  expect(researchListMatchesQuery("P-RESEARCH", { through: 40, after: 0 }, face)).toBe(true);
  expect(researchListMatchesQuery("P-OTHER", {}, face)).toBe(false);
  expect(researchListMatchesQuery("P-RESEARCH", { through: 41 }, face)).toBe(false);
  expect(researchListMatchesQuery("P-RESEARCH", { through: 40, after: 20 }, face)).toBe(false);
});

test("the generated public schema describes both directories and strict input", () => {
  const schema = JSON.parse(generateResearchListsSchema());
  expect(schema.$id).toBe(RESEARCH_LISTS_SCHEMA_ID);
  expect(Object.keys(schema.properties)).toEqual(["query", "evidence", "reviews"]);
  expect(schema.properties.query.additionalProperties).toBe(false);
  expect(schema.properties.query.properties.through.type).toBe("string");
  expect(schema.properties.evidence.properties.evidence.maxItems).toBe(8);
  expect(schema.properties.reviews.properties.reviews.maxItems).toBe(8);
  expect(schema.properties.reviews.properties.reviews.items.additionalProperties).toBe(false);
});
