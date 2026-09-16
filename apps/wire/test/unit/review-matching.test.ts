import { test } from "bun:test";
import assert from "node:assert/strict";
import { reviewMatchingFixture, matchFellow, matchHash, MATCH_AUTHOR, matchTestDependencies } from "./review-matching-fixture.ts";
import { REVIEW_MATCH_RECIPIENT_GUARD_SQL, REVIEW_MATCH_NO_ACTIVE_SQL } from "../../src/review-requests/matching-sql.ts";

// Real SQLite + the actual scientificIndependence function. The fixture's
// provenance decoder/central authorization are NOT a full Zod/auth proof.
test("matching chooses a different sponsor/family without interpreting model labels", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1),"alpha"); f.publish(f.person(2),"beta");
    f.sqlite.query("UPDATE enrollment_fellows SET model='beta/99', harness='another' WHERE fellow_id=?").run(matchFellow(1));
    const match=await f.match(); assert.equal(match?.reviewerId,matchFellow(2));
    assert.equal(match?.reviewerSponsor,"usr_2"); assert.ok(match?.provenancePin.digest);
    assert.equal(f.rows("SELECT last_used_at FROM fellow_tokens WHERE credential_id='cred-2'")[0]?.last_used_at,20);
    assert.equal(f.rows("SELECT * FROM review_requests").length,0);
  } finally { f.sqlite.close(); }
});

test("least pending invitations is private workload balancing, with deterministic Fellow-ID ties", async () => {
  const f=reviewMatchingFixture(); try {
    for(const n of [3,1,2]) f.publish(f.person(n),"beta");
    f.invite(1,"offer","C-OTHER");
    assert.equal((await f.match())?.reviewerId,matchFellow(2));
  } finally { f.sqlite.close(); }
});

for(const state of ["decline","cancel","complete","offer","accept"]) {
  test(`a prior ${state} recipient is never invited again to that statement version`, async () => {
    const f=reviewMatchingFixture(); try {
      for(const n of [1,2]) f.publish(f.person(n),"beta");
      f.invite(1,state,"C-1",state==="offer"||state==="accept"?f.now:f.now+1);
      assert.equal((await f.match())?.reviewerId,matchFellow(2));
    } finally { f.sqlite.close(); }
  });
}
for(const state of ["offer","accept"]) {
  test(`live ${state} blocks automatic fan-out instead of silently reassigning accepted work`, async () => {
    const f=reviewMatchingFixture(); try {
      for(const n of [1,2]) f.publish(f.person(n),"beta"); f.invite(1,state);
      await assert.rejects(f.match(), /CONFLICT/);
      assert.equal(f.calls.length,1);
    } finally { f.sqlite.close(); }
  });
}

test("same-sponsor Fellows and the author cannot be selected", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1,"usr_author"),"beta"); f.publish(MATCH_AUTHOR,"beta");
    assert.equal(await f.match(),null);
  } finally { f.sqlite.close(); }
});

test("no declared author family means no inferred match and no roster scan", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1),"beta");
    const body=JSON.stringify({claim_id:"C-1",statement:"test"});
    assert.equal(await f.match(matchTestDependencies,{...f.target,pin:{event_id:"EV-1",digest:matchHash(body),payload_json:body}}),null);
    assert.equal(f.calls.length,0);
  } finally { f.sqlite.close(); }
});

test("withdrawn or missing latest provenance cannot fall back to an older different-family declaration", async () => {
  for(const damage of ["redacted","deleted","missing-family","same-family","changed-sponsor","altered"]) {
    const f=reviewMatchingFixture(); try {
      const one=f.person(1); f.publish(one,"beta");
      const latest=f.publish(one,damage==="missing-family"?null:damage==="same-family"?"alpha":"beta",damage==="changed-sponsor"?{sponsor:"usr_old"}:{});
      if(damage==="redacted") f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(latest.event_id);
      if(damage==="deleted") f.sqlite.query("DELETE FROM event_content WHERE event_id=?").run(latest.event_id);
      if(damage==="altered") f.sqlite.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(latest.event_id);
      assert.equal(await f.match(),null,damage);
    } finally { f.sqlite.close(); }
  }
});

for(const change of [
  "UPDATE enrollment_fellows SET status='paused' WHERE fellow_id=?",
  "UPDATE enrollment_fellows SET status='suspicious_review' WHERE fellow_id=?",
  "UPDATE fellow_tokens SET revoked_at=1 WHERE fellow_id=?",
  "UPDATE fellow_tokens SET expires_at=1000000 WHERE fellow_id=?",
  "UPDATE fellow_tokens SET issued_at=1000001 WHERE fellow_id=?",
  "UPDATE fellow_tokens SET granted_scopes_json='[]' WHERE fellow_id=?",
  "UPDATE enrollment_grants SET granted_scopes_json='[]' WHERE fellow_id=?",
  "UPDATE fellow_tokens SET granted_resources_json='{\"problemBinding\":\"P-OTHER\"}' WHERE fellow_id=?",
  "UPDATE enrollment_grants SET granted_resources_json='{\"fellowGrantExpiresAt\":1000000}' WHERE fellow_id=?",
  "UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":0}' WHERE fellow_id=?",
]) {
  test(`recipient eligibility excludes ${change.split(" SET ")[1]}`, async () => {
    const f=reviewMatchingFixture(); try {
      f.publish(f.person(1),"beta"); f.sqlite.query(change).run(matchFellow(1));
      assert.equal(await f.match(),null);
    } finally { f.sqlite.close(); }
  });
}

test("an observer with review scope is eligible and central policy can still refuse", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1,"usr_1","observer"),"beta");
    assert.equal((await f.match())?.eligibility.role,"observer");
    assert.equal(await f.match({...matchTestDependencies,mayReview:()=>false}),null);
  } finally { f.sqlite.close(); }
});

test("prior committed review excludes only its exact target version even after body withdrawal", async () => {
  const f=reviewMatchingFixture(); try {
    const fellow=f.person(1); f.publish(fellow,"beta");
    const r=f.publish(fellow,"beta",{object:"R-7",kind:"review",type:"review.created",body:{target_claim_id:"C-1",target_version:1,scientific_provenance:{model_family_self_declared:"beta"}}});
    f.sqlite.query("INSERT INTO reviews VALUES(?,?,?,?,?,?,?)").run("P-DEMO","R-7",r.event_id,r.seq,"C-1",1,fellow);
    assert.equal(await f.match(),null);
    const next=f.publish(MATCH_AUTHOR,"alpha",{object:"C-1",type:"claim.revised",version:2,body:{claim_id:"C-1",base_version:1,statement:"revised",scientific_provenance:{model_family_self_declared:"alpha"}}});
    assert.equal((await f.match(matchTestDependencies,{...f.target,claim_version:2,pin:next}))?.reviewerId,fellow);
  } finally { f.sqlite.close(); }
});

test("a grant-wide budget spent on another problem still excludes the recipient", async () => {
  const f=reviewMatchingFixture(); try {
    const fellow=f.person(1); f.publish(fellow,"beta");
    f.sqlite.query("UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":1}' WHERE fellow_id=?").run(fellow);
    const elsewhere=f.publish(fellow,"beta",{problem:"P-OTHER"});
    f.sqlite.query("UPDATE events SET writer_credential_id='cred-1' WHERE id=?").run(elsewhere.event_id);
    assert.equal(await f.match(),null);
  } finally { f.sqlite.close(); }
});

test("current token-family and sponsor revocation exclude otherwise eligible Fellows", async () => {
  for(const kind of ["sponsor","family"]) {
    const f=reviewMatchingFixture(); try {
      f.publish(f.person(1),"beta");
      if(kind==="sponsor") f.sqlite.query("INSERT INTO enrollment_sponsor_security VALUES(?,?)").run("usr_1",10);
      else f.sqlite.query("INSERT INTO enrollment_fellow_security VALUES(?,?)").run(matchFellow(1),10);
      assert.equal(await f.match(),null);
    } finally { f.sqlite.close(); }
  }
});

test("a newer narrow credential cannot hide an older usable review credential", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1),"beta");
    f.sqlite.query("INSERT INTO fellow_tokens SELECT 'cred-new',fellow_id,sponsor_id,token_hash,20,expires_at,NULL,20,'bearer','[]','{}' FROM fellow_tokens WHERE credential_id='cred-1'").run();
    assert.equal((await f.match())?.eligibility.credential_id,"cred-1");
  } finally { f.sqlite.close(); }
});

test("private directives never cross into permission pins or match results", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1),"beta");
    for(const table of ["fellow_tokens","enrollment_grants"]) f.sqlite.query(`UPDATE ${table} SET granted_resources_json='{\"firstDirective\":\"PRIVATE-DIRECTIVE-SENTINEL\"}' WHERE fellow_id=?`).run(matchFellow(1));
    assert.ok(await f.match()); assert.ok(!JSON.stringify(await f.match()).includes("PRIVATE-DIRECTIVE"));
  } finally { f.sqlite.close(); }
});

test("matching scans at most 32 candidates, never cascades through the roster", async () => {
  const f=reviewMatchingFixture(); try {
    for(let i=1;i<=33;i++) f.publish(f.person(i),i===33?"beta":"alpha");
    assert.equal(await f.match(),null); assert.equal(f.calls.length,2);
  } finally { f.sqlite.close(); }
});

test("guard rejects changed recipient authority and active-target races", async () => {
  const f=reviewMatchingFixture(); try {
    f.publish(f.person(1),"beta"); const match=await f.match(); assert.ok(match);
    const input={problem:"P-DEMO",claim:"C-1",claim_version:1,now:f.now,reviewer:match.reviewerId,match:match.eligibility};
    const guard=()=>f.rows(`WITH input AS (SELECT ? AS j) SELECT ${REVIEW_MATCH_RECIPIENT_GUARD_SQL} AS ok FROM input`,JSON.stringify(input))[0]?.ok;
    assert.equal(guard(),1);
    f.sqlite.query("UPDATE problem_memberships SET role='observer' WHERE fellow_id=?").run(matchFellow(1)); assert.equal(guard(),0);
    f.sqlite.query("UPDATE problem_memberships SET role='contributor' WHERE fellow_id=?").run(matchFellow(1));
    f.sqlite.query("UPDATE fellow_tokens SET revoked_at=1 WHERE fellow_id=?").run(matchFellow(1)); assert.equal(guard(),0);
    f.invite(1,"offer");
    assert.equal(f.rows(`WITH input AS (SELECT ? AS j) SELECT ${REVIEW_MATCH_NO_ACTIVE_SQL} AS ok FROM input`,JSON.stringify(input))[0]?.ok,0);
  } finally { f.sqlite.close(); }
});
