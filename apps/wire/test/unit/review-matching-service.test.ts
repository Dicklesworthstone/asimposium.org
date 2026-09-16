import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { createReviewRequest, respondReviewRequest } from "../../src/review-requests/service.ts";
import { ReviewMatchNotFoundError } from "../../src/review-requests/matching.ts";
import { readRequest, type ReplayProtector } from "../../src/review-requests/store.ts";
import { matchHash, MATCH_AUTHOR, matchFellow, reviewMatchingFixture } from "./review-matching-fixture.ts";

// In the normal Bun workspace these imports exercise canonical Zod and central
// authorization as well as the real selector/target/store composition. The
// minimal database is explicitly not the complete migration-lineage fixture.
const matched = { claim_id:"C-1", claim_version:1, match:"different-family" as const };
type Fixture=ReturnType<typeof reviewMatchingFixture>;
function actor(f:Fixture,n=0):FellowCredentialBinding {
  const fellow=n===0?MATCH_AUTHOR:matchFellow(n);
  return { fellowId:fellow,sponsorId:n===0?"usr_author":`usr_${n}`,credentialId:`cred-${n}`,name:`fellow-${n}`,
    model:"model/label",harness:"harness",tokenHash:matchHash(fellow),issuedAt:10,expiresAt:f.now+100000,
    credentialProfile:"bearer",fellowStatus:"active",grantedScopes:["promote","review"],grantedResources:{} };
}
// Deliberate in-process replay-transport fixture. Cryptographic settlement is
// exercised with actual WebCrypto in review-matching-commit.test.ts.
const replay:ReplayProtector={
  async seal(value,context){return {ciphertext:JSON.stringify({value,context}),initializationVector:"test-only"};},
  async open(value,context){const stored=JSON.parse(value.ciphertext);assert.equal(stored.context,context);return stored.value;},
};
function create(f:Fixture,key="match-1",db=f.db) {
  return createReviewRequest(db,replay,actor(f),"P-DEMO",matched,key,f.now);
}
function count(f:Fixture,table="review_requests") {return f.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n;}

test("production invitation service composes matching, immutable target, notice and replay",async()=>{
  const f=reviewMatchingFixture();try {
    f.publish(f.person(1),"beta");const receipt=await create(f);
    assert.equal(receipt.reviewer_id,matchFellow(1));assert.equal(receipt.claim_event_id,f.target.pin.event_id);
    assert.equal(receipt.status,"offered");assert.equal(count(f),1);assert.equal(count(f,"fellow_inbox_notices"),1);
    assert.ok(!JSON.stringify(receipt).includes("scientific_provenance"));assert.ok(!JSON.stringify(receipt).includes("credential"));
    assert.ok(await readRequest(f.db,"P-DEMO",matchFellow(1),receipt.request_id));
  }finally{f.sqlite.close();}
});

test("unchanged match replay keeps recipient after decline; new intent chooses a different Fellow",async()=>{
  const f=reviewMatchingFixture();try {
    for(const n of [1,2])f.publish(f.person(n),"beta");const first=await create(f);
    await respondReviewRequest(f.db,replay,actor(f,1),"P-DEMO",first.request_id,{action:"decline",expected_version:1},"decline",f.now+1);
    assert.deepEqual(await create(f),first);
    const second=await create(f,"match-2");assert.equal(second.reviewer_id,matchFellow(2));assert.notEqual(second.request_id,first.request_id);
    assert.equal(count(f),2);assert.equal(count(f,"review_request_events"),3);
  }finally{f.sqlite.close();}
});

test("active request cannot be silently replaced by another matching key",async()=>{
  const f=reviewMatchingFixture();try {
    for(const n of [1,2])f.publish(f.person(n),"beta");await create(f);
    await assert.rejects(create(f,"another"),/CONFLICT/);assert.equal(count(f),1);assert.equal(count(f,"fellow_inbox_notices"),1);
  }finally{f.sqlite.close();}
});

test("explicit author cancellation permits rematching without erasing accepted history",async()=>{
  const f=reviewMatchingFixture();try {
    for(const n of [1,2])f.publish(f.person(n),"beta");const first=await create(f);
    await respondReviewRequest(f.db,replay,actor(f,1),"P-DEMO",first.request_id,{action:"accept",expected_version:1},"accept",f.now+1);
    await assert.rejects(create(f,"another"),/CONFLICT/);
    await respondReviewRequest(f.db,replay,actor(f),"P-DEMO",first.request_id,{action:"cancel",expected_version:2},"cancel",f.now+2);
    assert.equal((await create(f,"replacement")).reviewer_id,matchFellow(2));
    assert.deepEqual(f.rows("SELECT action FROM review_request_events ORDER BY rowid").map(row=>row.action),["offer","accept","cancel","offer"]);
  }finally{f.sqlite.close();}
});

test("missing or same-family provenance yields bounded no-match and no side effects",async()=>{
  for(const family of [null,"alpha"]){
    const f=reviewMatchingFixture();try {
      f.publish(f.person(1),family);await assert.rejects(create(f),ReviewMatchNotFoundError);
      assert.equal(count(f),0);assert.equal(count(f,"review_request_replays"),0);assert.equal(count(f,"fellow_inbox_notices"),0);
    }finally{f.sqlite.close();}
  }
});

test("a non-author cannot query matching via somebody else's target",async()=>{
  const f=reviewMatchingFixture();try {
    f.publish(f.person(1),"beta");f.calls.length=0;
    await assert.rejects(createReviewRequest(f.db,replay,actor(f,1),"P-DEMO",matched,"steal",f.now),/INELIGIBLE/);
    assert.ok(!f.calls.some(sql=>sql.includes("AS binding_json")));assert.equal(count(f),0);
  }finally{f.sqlite.close();}
});

test("matched requests still require promotion authority and never manufacture reviewer authority",async()=>{
  const f=reviewMatchingFixture();try {
    f.publish(f.person(1),"beta");
    await assert.rejects(createReviewRequest(f.db,replay,{...actor(f),grantedScopes:["review"]},"P-DEMO",matched,"not-authorized",f.now),/INELIGIBLE/);
    assert.equal(count(f),0);
    const receipt=await create(f);
    await respondReviewRequest(f.db,replay,actor(f,1),"P-DEMO",receipt.request_id,{action:"accept",expected_version:1},"accept",f.now+1);
    await assert.rejects(respondReviewRequest(f.db,replay,actor(f,1),"P-DEMO",receipt.request_id,{action:"complete",expected_version:2,review_id:"R-missing"},"complete",f.now+2),/INELIGIBLE/);
    assert.equal(count(f,"reviews"),0);
  }finally{f.sqlite.close();}
});

test("named invitations remain possible with unknown family; matching never falls back to them",async()=>{
  const f=reviewMatchingFixture();try {
    f.person(1);
    await assert.rejects(create(f),ReviewMatchNotFoundError);
    const receipt=await createReviewRequest(f.db,replay,actor(f),"P-DEMO",{claim_id:"C-1",claim_version:1,reviewer_id:matchFellow(1)},"named",f.now);
    assert.equal(receipt.reviewer_id,matchFellow(1));assert.equal(count(f),1);
    await assert.rejects(createReviewRequest(f.db,replay,actor(f),"P-DEMO",matched,"named",f.now),/IDEMPOTENCY_CONFLICT/);
  }finally{f.sqlite.close();}
});

test("winner settling between replay and active-target checks is replayed, not reported as an error",async()=>{
  const f=reviewMatchingFixture();try {
    f.publish(f.person(1),"beta");let winner:Awaited<ReturnType<typeof create>>|undefined;let injected=false;
    const db={prepare(sql:string){
      const statement=f.db.prepare(sql);
      if(!sql.includes("END AS active"))return statement;
      const originalBind=statement.bind.bind(statement);
      statement.bind=(...args:unknown[])=>{
        const bound=originalBind(...args);const originalFirst=bound.first.bind(bound);
        bound.first=(async()=>{if(!injected){injected=true;winner=await create(f);}return originalFirst();}) as typeof bound.first;
        return bound;
      };
      return statement;
    },batch:f.db.batch.bind(f.db)} as D1Database;
    const result=await create(f,"match-1",db);assert.ok(injected);assert.deepEqual(result,winner);assert.equal(count(f),1);
  }finally{f.sqlite.close();}
});

test("recipient authority reduction during selection prevents all invitation effects",async()=>{
  const f=reviewMatchingFixture();try {
    f.publish(f.person(1),"beta");
    const p:ReplayProtector={...replay,async seal(value,context){
      f.sqlite.query("UPDATE enrollment_grants SET granted_scopes_json='[]' WHERE fellow_id=?").run(matchFellow(1));
      return replay.seal(value,context);
    }};
    await assert.rejects(createReviewRequest(f.db,p,actor(f),"P-DEMO",matched,"race",f.now),/CONFLICT/);
    assert.equal(count(f),0);assert.equal(count(f,"fellow_inbox_notices"),0);
  }finally{f.sqlite.close();}
});
