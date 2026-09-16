import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  REVIEW_REQUEST_OPERATIONS,
  reviewRequestParameters,
  reviewRequestResponses,
} from "../../src/discovery/review-requests-discovery.ts";
import { reviewInvitationLink } from "../../src/inbox/review-invitation-link.ts";

const id = `RR-${"a".repeat(32)}`;
test("inbox links only target canonical invitation records, never work-product text", () => {
  assert.equal(reviewInvitationLink("P-DEMO", id), `/v1/p/P-DEMO/review-requests/${id}`);
  for (const bad of [
    null,
    undefined,
    "C-1",
    "https://example.test/",
    "RR-../../secret",
    `${id}\n`,
  ]) {
    assert.equal(reviewInvitationLink("P-DEMO", bad), null);
  }
  for (const bad of [null, undefined, "P-DEMO/other", "P--DEMO", "P-DEMO?token=x", "P-DEMO\n"]) {
    assert.equal(reviewInvitationLink(bad, id), null);
  }
});
test("disclosed invitation operations all require Fellow authentication", () => {
  assert.equal(REVIEW_REQUEST_OPERATIONS.length, 4);
  assert.ok(REVIEW_REQUEST_OPERATIONS.every((row) => row[1] === "fellow-bearer"));
  assert.equal(
    REVIEW_REQUEST_OPERATIONS.filter((row) => row[0].startsWith("POST") && row[3]).length,
    2,
  );
});
test("OpenAPI distinguishes creation receipts from participant reads", () => {
  const origin = "https://a-staging.asimposium.org",
    path = "/v1/p/{problem}/review-requests";
  type ResponseDoc = Record<
    string,
    { content: { "application/json": { schema: { $ref: string } } } }
  >;
  const post = reviewRequestResponses(path, origin, "POST") as ResponseDoc;
  assert.ok(post["201"]);
  assert.ok(!post["200"]);
  assert.equal(
    post["201"].content["application/json"].schema.$ref,
    `${origin}/schemas/review-requests.v1.json#/properties/receipt`,
  );
  const get = reviewRequestResponses(path, origin, "GET") as ResponseDoc;
  assert.ok(get["200"]);
  assert.equal(
    get["200"].content["application/json"].schema.$ref,
    `${origin}/schemas/review-requests.v1.json#/properties/response`,
  );
  const one = reviewRequestResponses(`${path}/{requestId}`, origin, "GET") as ResponseDoc;
  assert.ok(one["200"]);
  assert.equal(
    one["200"].content["application/json"].schema.$ref,
    `${origin}/schemas/review-requests.v1.json#/properties/view`,
  );
});
test("write replay header and private cursor appear only on their own routes", () => {
  const path = "/v1/p/{problem}/review-requests",
    origin = "https://a.asimposium.org";
  type ParamDoc = { name: string };
  assert.equal(
    (reviewRequestParameters(path, origin, "POST")[0] as ParamDoc).name,
    "Idempotency-Key",
  );
  assert.equal((reviewRequestParameters(path, origin, "GET")[0] as ParamDoc).name, "after");
  assert.deepEqual(reviewRequestParameters(`${path}/{requestId}`, origin, "GET"), []);
  assert.deepEqual(reviewRequestParameters("/v1/p/{problem}/other", origin, "GET"), []);
  assert.equal(reviewRequestResponses("/public/review-requests", origin, "GET"), undefined);
});
