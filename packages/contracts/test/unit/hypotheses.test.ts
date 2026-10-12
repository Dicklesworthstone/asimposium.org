import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { MAX_CAUSED_BY_PER_MEMBER } from "../../src/batch";
import {
  HypothesesQuerySchema,
  HypothesesResponseSchema,
  HypothesisPublicationSchema,
  PublicHypothesisIdSchema,
} from "../../src/hypotheses";
import { generateHypothesesSchema } from "../../src/hypotheses-schema";
import { HypothesisRequestSchema } from "../../src/sessions";

const fixture = async (path: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));

for (const query of [
  { through: "1\n" },
  { after: "01" },
  { after: "-0" },
  { through: "9007199254740992" },
  { after: "2", through: "1" },
  { liveOnly: true },
  { limit: "3" },
]) {
  test(`reject noncanonical public query ${JSON.stringify(query)}`, () =>
    assert.equal(HypothesesQuerySchema.safeParse(query).success, false));
}
test("read body uses the published write vocabulary with nullable expected evidence", () => {
  const body = {
    route: "A route",
    mechanism: "A mechanism",
    falsifier: "A test",
    expected_evidence: null,
    discriminating_predictions: [],
    origin: "proposed",
    body_md: "Work",
  };
  assert.ok(HypothesisPublicationSchema.safeParse(body).success);
  assert.equal(
    HypothesisPublicationSchema.safeParse({ ...body, disposition: "proved" }).success,
    false,
  );
  assert.equal(HypothesisPublicationSchema.safeParse({ ...body, falsifier: "" }).success, false);
});
test("empty ranges require consistent cursor and continuation accounting", () => {
  const face = {
    schema: "https://a.asimposium.org/schemas/hypotheses.v1.json",
    problem_id: "P-DEMO",
    cursor: 0,
    after: 0,
    hypotheses: [],
    next_after: null,
    omitted: [],
  };
  assert.ok(HypothesesResponseSchema.safeParse(face).success);
  assert.equal(HypothesesResponseSchema.safeParse({ ...face, next_after: 1 }).success, false);
  assert.equal(
    HypothesesResponseSchema.safeParse({ ...face, omitted: ["page_limit"] }).success,
    false,
  );
});
test("public schema is generated deterministically from Zod, with no clock or caller data", () => {
  const first = generateHypothesesSchema();
  assert.equal(first, generateHypothesesSchema());
  const document = JSON.parse(first);
  assert.equal(document.$id, "https://a.asimposium.org/schemas/hypotheses.v1.json");
  assert.ok(document.properties.query);
  assert.ok(document.properties.response);
});

test("hypothesis ids preserve minted Crockford and exact legacy atomic ids", () => {
  for (const id of ["H-BEM99EW06XZAW41FF2RHH10XVT", "H-12", `H-${"abcdef01".repeat(8)}`])
    assert.ok(PublicHypothesisIdSchema.safeParse(id).success, id);
  for (const id of [
    "H-bem99",
    "H-ILOU",
    "H-",
    "C-12",
    "H-12\n",
    `H-${"1".repeat(79)}`,
    `H-${"a".repeat(63)}`,
    `H-${"a".repeat(65)}`,
    `H-${"g".repeat(64)}`,
    `H-${"a".repeat(64)}\n`,
  ])
    assert.equal(PublicHypothesisIdSchema.safeParse(id).success, false, id);
});

test("published sponsor and batch goldens survive Zod and the served JSON Schema", async () => {
  const face = await fixture("valid/hypotheses-server-metadata.json");
  const schema = JSON.parse(generateHypothesesSchema());
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const published = ajv.compile(schema.properties.response);
  assert.deepEqual(HypothesesResponseSchema.parse(face), face);
  assert.equal(published(face), true, JSON.stringify(published.errors));
  for (const item of face.hypotheses) {
    const metadata = item.content.sponsor_promotion
      ? { sponsor_promotion: item.content.sponsor_promotion }
      : { caused_by: item.content.caused_by };
    const { sponsor_promotion: _sponsor, caused_by: _causes, ...science } = item.content;
    const request = { ...science, expected_evidence: "A finite witnessed comparison" };
    assert.equal(HypothesisRequestSchema.safeParse(request).success, true);
    assert.equal(HypothesisRequestSchema.safeParse({ ...request, ...metadata }).success, false);
  }
  const invalid = await fixture("invalid/hypotheses-private-promotion-metadata.json");
  assert.equal(HypothesesResponseSchema.safeParse(invalid).success, false);
  assert.equal(published(invalid), false);
  for (const metadata of [
    { caused_by: ["tmp:parent"] },
    { caused_by: [{ scope: "problem", scope_id: "P-DEMO", event_id: "E-1", seq: 0 }] },
    { caused_by: [{ scope: "sponsor", scope_id: "P-DEMO", event_id: "E-1", seq: 1 }] },
    {
      caused_by: [{ scope: "problem", scope_id: "P-DEMO", event_id: "E-1", seq: 1, key: "secret" }],
    },
    {
      caused_by: Array.from({ length: MAX_CAUSED_BY_PER_MEMBER + 1 }, (_, i) => ({
        scope: "problem",
        scope_id: "P-DEMO",
        event_id: `E-${i + 1}`,
        seq: i + 1,
      })),
    },
    { sponsor_promotion: { acting_sponsor_id: "usr_publisher", workshop_version: 0 } },
    {
      sponsor_promotion: {
        acting_sponsor_id: "usr_publisher",
        workshop_version: 1,
        workshop_id: "W-private",
      },
    },
    { client_occurred_at: "2026-09-01T00:00:00.000Z" },
  ]) {
    const malformed = structuredClone(face);
    Object.assign(malformed.hypotheses[0].content, metadata);
    assert.equal(
      HypothesesResponseSchema.safeParse(malformed).success,
      false,
      JSON.stringify(metadata),
    );
    assert.equal(published(malformed), false, JSON.stringify(metadata));
  }
});
