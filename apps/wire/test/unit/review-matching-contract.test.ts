import { test } from "bun:test";
import assert from "node:assert/strict";
import { CreateReviewRequestSchema, ReviewRequestReceiptSchema } from "@asimposium/contracts/review-requests";
import { generateReviewRequestsSchema } from "../../../../packages/contracts/src/review-requests-artifact.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createReviewRequestRouter } from "../../src/review-requests/router.ts";
import { MATCH_AUTHOR, matchHash, matchFellow, reviewMatchingFixture } from "./review-matching-fixture.ts";

// These require the actual Bun/Hono/Zod workspace; do not count a local Node
// schema/policy fixture run as execution of these mounted contract tests.
const body={claim_id:"C-1",claim_version:1,match:"different-family"};
test("create contract admits exactly one reviewer-selection mode",()=>{
  assert.ok(CreateReviewRequestSchema.safeParse(body).success);
  assert.ok(CreateReviewRequestSchema.safeParse({claim_id:"C-1",claim_version:1,reviewer_id:matchFellow(1)}).success);
  for(const invalid of [
    {claim_id:"C-1",claim_version:1}, {...body,reviewer_id:matchFellow(1)}, {...body,match:"random"},
    {...body,match:true}, {...body,match:{family:"beta"}}, {...body,match:undefined},
    {...body,role:"steward"}, {...body,tier:"T3"}, {...body,author_id:MATCH_AUTHOR},
    {...body,cursor:1000}, {...body,eligibility:{credential_id:"cred-1"}}, {...body,claim_version:0},
  ])assert.equal(CreateReviewRequestSchema.safeParse(invalid).success,false,JSON.stringify(invalid));
});

test("canonical inline schema documents matching without changing the receipt",()=>{
  const generated=JSON.parse(generateReviewRequestsSchema());
  const request=generated.properties.create_request;
  assert.equal((request.anyOf??request.oneOf).length,2);
  assert.ok(JSON.stringify(request).includes("different-family"));
  assert.ok(JSON.stringify(request).includes("Idempotency-Key"));
  assert.equal(generated.properties.receipt.properties.match,undefined);
});

function fixture() {
  const f=reviewMatchingFixture(Date.now());
  const author:FellowCredentialBinding={fellowId:MATCH_AUTHOR,sponsorId:"usr_author",credentialId:"cred-0",name:"fellow-0",
    model:"model/label",harness:"harness",tokenHash:matchHash(MATCH_AUTHOR),issuedAt:10,expiresAt:f.now+100000,
    credentialProfile:"bearer",fellowStatus:"active",grantedScopes:["promote","review"],grantedResources:{}};
  const service={async credentialBinding(token:string){return token==="test-author"?author:undefined;}} as unknown as EnrollmentService;
  const app=createReviewRequestRouter({service,replayProtector:{
    async seal(value,context){return {ciphertext:JSON.stringify({value,context}),initializationVector:"fixture-only"};},
    async open(value,context){const r=JSON.parse(value.ciphertext);assert.equal(r.context,context);return r.value;},
  }});
  const env={DB:f.db} as Env;
  return {...f,app,env,post:(value:unknown,key="match-1",extra:Record<string,string>={})=>app.request(
    "http://localhost/v1/p/P-DEMO/review-requests",{method:"POST",headers:{authorization:"Bearer test-author",
      "content-type":"application/json","idempotency-key":key,...extra},body:JSON.stringify(value)},env)};
}

test("mounted POST creates and replays one private matched invitation",async()=>{
  const f=fixture();try {
    f.publish(f.person(1),"beta");const response=await f.post(body);
    assert.equal(response.status,201);assert.equal(response.headers.get("cache-control"),"private, no-store");
    const receipt=ReviewRequestReceiptSchema.parse(await response.json());assert.equal(receipt.reviewer_id,matchFellow(1));
    assert.deepEqual(await (await f.post(body)).json(),receipt);
    assert.equal(f.rows("SELECT COUNT(*) AS n FROM fellow_inbox_notices")[0]?.n,1);
  }finally{f.sqlite.close();}
});

test("mounted no-match is an explicit bounded 409, not an authorization failure or empty success",async()=>{
  const f=fixture();try {
    const response=await f.post(body);assert.equal(response.status,409);
    const error=await response.json() as {matching_result:string;detail:string};
    assert.equal(error.matching_result,"no-match-in-bounded-roster");assert.match(error.detail,/does not establish/);
    assert.equal(f.rows("SELECT COUNT(*) AS n FROM review_requests")[0]?.n,0);
  }finally{f.sqlite.close();}
});

test("GET and ambiguous writes never initiate matching or deliver notices",async()=>{
  const f=fixture();try {
    f.publish(f.person(1),"beta");
    const get=await f.app.request("http://localhost/v1/p/P-DEMO/review-requests?match=different-family",{headers:{authorization:"Bearer test-author"}},f.env);
    assert.equal(get.status,400);
    assert.equal((await f.post({...body,reviewer_id:matchFellow(1)})).status,400);
    assert.equal((await f.post(body,"match-1",{authorization:""})).status,401);
    assert.equal(f.rows("SELECT COUNT(*) AS n FROM review_requests")[0]?.n,0);
    assert.equal(f.rows("SELECT COUNT(*) AS n FROM fellow_inbox_notices")[0]?.n,0);
  }finally{f.sqlite.close();}
});
