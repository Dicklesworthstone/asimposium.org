import { test } from "bun:test";
import assert from "node:assert/strict";
import { REVIEW_REQUEST_OPERATIONS, reviewRequestParameters, reviewRequestResponses } from "../../src/discovery/review-requests-discovery.ts";

const origin="https://a-staging.asimposium.org", path="/v1/p/{problem}/review-requests";
test("matchmaking is explicit on the existing authenticated POST, never a new read-side effect",()=>{
  assert.equal(REVIEW_REQUEST_OPERATIONS.length,4);
  assert.ok(REVIEW_REQUEST_OPERATIONS.every(row=>row[1]==="fellow-bearer"));
  const post=REVIEW_REQUEST_OPERATIONS.find(row=>row[0]==="POST /v1/p/:problem/review-requests");
  assert.equal(post?.[3],"review-requests:create_request");
  assert.match(post?.[2]??"",/match: different-family/);
  assert.match(post?.[2]??"",/32 eligible Fellows/);
  assert.match(post?.[2]??"",/new key may rematch/);
  assert.match(REVIEW_REQUEST_OPERATIONS[0]?.[2]??"",/Reads never initiate/);
});

test("replay guidance retains the original recipient and uses a new key for a new intent",()=>{
  const parameters=reviewRequestParameters(path,origin,"POST") as {name:string;description:string}[];
  assert.equal(parameters[0]?.name,"Idempotency-Key");
  assert.match(parameters[0]?.description??"",/originally matched recipient/);
  assert.match(parameters[0]?.description??"",/requires a new key/);
  assert.equal((reviewRequestParameters(path,origin,"GET")[0] as {name:string}).name,"after");
});

test("matching retains receipt schemas and advertises bounded no-match without leaking candidates",()=>{
  const post=reviewRequestResponses(path,origin,"POST") as Record<string,{description:string;content:Record<string,{schema:{$ref:string}}>}>;
  assert.equal(post["201"]?.content["application/json"]?.schema.$ref,`${origin}/schemas/review-requests.v1.json#/properties/receipt`);
  assert.match(post["409"]?.description??"",/no-match-in-bounded-roster/);
  assert.match(post["409"]?.description??"",/not that no reviewer exists/);
  assert.equal(reviewRequestResponses(path,origin,"GET")?.["409"],undefined);
  assert.equal(reviewRequestResponses("/public/match",origin,"POST"),undefined);
});
