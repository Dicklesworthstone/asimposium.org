import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SPONSOR_FOLLOWS_SCHEMA_ID,
  SponsorFollowListResponseSchema,
  SponsorFollowQuerySchema,
  SponsorFollowReceiptSchema,
  SponsorFollowRequestSchema,
  generateSponsorFollowsSchema,
} from "../../src/sponsor-follows.ts";

test("sponsor follow golden requests use a closed desired-state contract", () => {
  const valid = JSON.parse(readFileSync(new URL("../fixtures/valid/sponsor-follow-request.json", import.meta.url), "utf8"));
  const invalid = JSON.parse(readFileSync(new URL("../fixtures/invalid/sponsor-follow-request.json", import.meta.url), "utf8"));
  expect(SponsorFollowRequestSchema.safeParse(valid).success).toBe(true);
  expect(SponsorFollowRequestSchema.safeParse({ ...valid, following: false }).success).toBe(true);
  expect(SponsorFollowRequestSchema.safeParse(invalid).success).toBe(false);
  expect(SponsorFollowQuerySchema.safeParse({ after: ["P-DEMO", "P-OTHER"] }).success).toBe(false);
  expect(SponsorFollowQuerySchema.safeParse({ sponsor_id: "usr_other" }).success).toBe(false);
  expect(SponsorFollowReceiptSchema.safeParse({ problem_id: "P-DEMO", following: false, followed_at: null }).success).toBe(true);
});

test("private follow pages reject contradictory cursors and foreign event scopes", () => {
  const follow = { problem_id: "P-DEMO", followed_at: 1000, cursor: null, events: [], reviews: [], omitted: ["public_activity_unavailable"] };
  const page = { schema: SPONSOR_FOLLOWS_SCHEMA_ID, sponsor_id: "usr_owner", follows: [follow], next_after: null };
  expect(SponsorFollowListResponseSchema.safeParse(page).success).toBe(true);
  expect(SponsorFollowListResponseSchema.safeParse({ ...page, follows: [follow, follow] }).success).toBe(false);
  expect(SponsorFollowListResponseSchema.safeParse({ ...page, next_after: "P-AAA" }).success).toBe(false);
  const envelope = {
    record: "event", problem_id: "P-OTHER", seq: 1, event: null, body_omitted: "undisclosed_event",
  };
  expect(SponsorFollowListResponseSchema.safeParse({
    ...page, follows: [{ ...follow, cursor: 1, events: [envelope] }],
  }).success).toBe(false);
});

test("the served follow schema is generated from the exact shared request and response contracts", () => {
  const schema = JSON.parse(generateSponsorFollowsSchema());
  expect(schema.$id).toBe(SPONSOR_FOLLOWS_SCHEMA_ID);
  expect(schema.properties.request.required).toEqual(["problem_id", "following"]);
  expect(schema.properties.request.additionalProperties).toBe(false);
  expect(schema.properties.response.properties.follows.maxItems).toBe(5);
  expect(schema.properties.response.properties.follows.items.properties.events.maxItems).toBe(5);
});
