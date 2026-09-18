import assert from "node:assert/strict";
import { test } from "bun:test";
import { ArtifactInspectionError, artifactSha256 } from "../../src/krater/artifact-inspection.ts";
import {
  ArtifactPublicationError, publicationStatus, readPublicationJob, requestArtifactPublication,
} from "../../src/krater/artifact-publication-store.ts";
import { deliverArtifactPublication, drainArtifactPublications, PUBLICATION_LEASE_MS } from "../../src/krater/artifact-publication-outbox.ts";
import { publicationFixture } from "./artifact-publication-fixture.ts";

const queued = async () => {
  const f=await publicationFixture();
  const receipt=await requestArtifactPublication(f.options,f.actor,f.upload,f.input,"publish-one");
  return {...f,receipt,id:receipt.publication_id};
};
const errorCode=(code:string)=>(e:unknown)=>e instanceof ArtifactPublicationError&&e.code===code;
const cursor=(f:Awaited<ReturnType<typeof publicationFixture>>)=>(f.sql.query("SELECT cursor FROM public_cursor").get() as {cursor:number}).cursor;

test("publication atomically binds an exact evidence event without modifying its scientific content",async()=>{
  const f=await publicationFixture();const before=f.sql.query("SELECT * FROM event_content WHERE event_id='EV-1'").get();
  const r=await requestArtifactPublication(f.options,f.actor,f.upload,f.input,"publish-one");
  assert.equal(r.initial_delivery,"queued");assert.equal(r.verification,"bytes-only");
  assert.equal(f.count("artifact_publications"),1);assert.equal(f.count("artifact_publication_jobs"),1);
  assert.equal(f.count("events"),2);assert.equal(f.reservations(),1);assert.equal(cursor(f),2);
  assert.deepEqual(f.sql.query("SELECT * FROM event_content WHERE event_id='EV-1'").get(),before);
  assert.equal(f.publicStore.writes(),0);assert.equal(f.screens(),0);
  const publicPayload=JSON.parse((f.sql.query("SELECT payload_json FROM event_content WHERE event_id=?").get(r.event_id) as {payload_json:string}).payload_json);
  for(const field of ["upload_id","credential_id","screeningBody","replay_ciphertext"])assert.equal(field in publicPayload,false);
});
test("exact replay does not repeat storage inspection, reserve quota or create a second event",async()=>{
  const f=await queued();f.privateStore.hooks.get=()=>{throw new Error("should not read bytes for replay");};
  const again=await requestArtifactPublication(f.options,f.actor,f.upload,f.input,"publish-one");
  assert.deepEqual(again,f.receipt);assert.equal(f.reservations(),1);assert.equal(f.count("events"),2);assert.equal(cursor(f),2);
});
test("thirty concurrent same-key requests converge on one durable publication",async()=>{
  const f=await publicationFixture();
  const rows=await Promise.all(Array.from({length:30},()=>requestArtifactPublication(f.options,f.actor,f.upload,f.input,"same-key")));
  assert.equal(new Set(rows.map(r=>r.publication_id)).size,1);assert.equal(f.count("artifact_publication_jobs"),1);
  assert.equal(f.count("events"),2);assert.equal(f.reservations(),1);assert.equal(cursor(f),2);
});
test("changed requests cannot reuse a key and alternate keys cannot duplicate an evidence binding",async()=>{
  const f=await queued();
  await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,{...f.input,evidence_id:"E-2"},"publish-one"),errorCode("CONFLICT"));
  await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,f.input,"another-key"),errorCode("CONFLICT"));
  assert.equal(f.reservations(),1);assert.equal(f.count("artifact_publications"),1);
});
test("unverified uploads, wrong evidence pins and another author cannot acquire a public binding",async()=>{
  for(const change of ["upload","digest","author"]){
    const f=await publicationFixture();
    if(change==="upload")f.sql.exec("UPDATE artifact_uploads SET state='presigned'");
    if(change==="author")f.sql.exec("UPDATE evidence SET author_fellow_id='somebody-else'");
    await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,
      change==="digest"?{...f.input,evidence_digest:`sha256:${"f".repeat(64)}`}:f.input,"key"));
    assert.equal(f.count("artifact_publications"),0);assert.equal(f.reservations(),0);
  }
});
for(const [name,mutation] of [
  ["revoked token","UPDATE fellow_tokens SET revoked_at=1800000000000"],
  ["paused Fellow","UPDATE enrollment_fellows SET status='paused'"],
  ["sponsor panic","INSERT INTO enrollment_sponsor_security VALUES('sponsor-one',1800000000000)"],
  ["removed membership","DELETE FROM problem_memberships"],
  ["observer role","UPDATE problem_memberships SET role='observer'"],
  ["closed current session","UPDATE sessions SET closed_at='2027-01-01T00:00:00.000Z'"],
  ["expired credential","UPDATE fellow_tokens SET expires_at=1800000000000"],
  ["private target","UPDATE problems SET status='private-draft'"],
  ["scope removal","UPDATE fellow_tokens SET granted_scopes_json='[\"upload-artifacts\"]'; UPDATE enrollment_grants SET granted_scopes_json='[\"upload-artifacts\"]'"],
  ["changed grant binding","UPDATE fellow_tokens SET granted_resources_json='{\"problemBinding\":\"P-OTHER\"}'; UPDATE enrollment_grants SET granted_resources_json='{\"problemBinding\":\"P-OTHER\"}'"],
  ["exhausted event grant","UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":1}'; UPDATE enrollment_grants SET granted_resources_json='{\"eventBudget\":1}'"],
  ["expired grant","UPDATE fellow_tokens SET granted_resources_json='{\"fellowGrantExpiresAt\":1800000000000}'; UPDATE enrollment_grants SET granted_resources_json='{\"fellowGrantExpiresAt\":1800000000000}'"],
] as const){
  test(`commit-time ${name} rolls back the event, binding, job and cursor`,async()=>{
    const f=await publicationFixture();f.hooks.beforeWrite=()=>f.sql.exec(mutation);
    await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,f.input,"key"));
    assert.equal(f.count("events"),1);assert.equal(f.count("artifact_publications"),0);
    assert.equal(f.count("artifact_publication_jobs"),0);assert.equal(cursor(f),1);
    assert.equal(f.count("public_write_attempt_reservations"),1);
  });
}
test("changing evidence bytes during the storage read cannot pass through a matching digest column",async()=>{
  const f=await publicationFixture();f.hooks.beforeWrite=()=>f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-1'");
  await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,f.input,"key"));
  assert.equal(f.count("artifact_publications"),0);assert.equal(cursor(f),1);
});
test("a quota reservation for different request bytes cannot authorize publication",async()=>{
  const f=await publicationFixture();f.hooks.beforeWrite=()=>f.sql.exec("UPDATE public_write_attempt_reservations SET request_digest='wrong'");
  await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,f.input,"key"));
  assert.equal(f.count("events"),1);assert.equal(f.count("artifact_publications"),0);
});
test("oversized complete screening documents remain private without creating a publication",async()=>{
  const f=await publicationFixture();const bytes=new TextEncoder().encode("x".repeat(80_000));const digest=await artifactSha256(bytes);
  f.sql.query("UPDATE artifact_uploads SET sha256=?,size_bytes=?").run(digest,bytes.length);
  f.privateStore.data.set(`cas/sha256/${digest}`,{bytes,httpMetadata:{}});
  await assert.rejects(requestArtifactPublication(f.options,f.actor,f.upload,f.input,"key"),
    e=>e instanceof ArtifactInspectionError&&e.code==="ARTIFACT_PUBLICATION_TOO_LARGE");
  assert.equal(f.count("events"),1);assert.equal(f.count("artifact_publications"),0);assert.equal(f.publicStore.writes(),0);
});
test("delivery reaches public R2 only after a durable pass and release authorization",async()=>{
  const f=await queued();f.publicStore.hooks.put=()=>{
    assert.equal((f.sql.query("SELECT state FROM artifact_publication_jobs").get() as {state:string}).state,"release-authorized");
    assert.equal(f.count("artifact_publications"),1);
  };
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"published");
  const job=(await readPublicationJob(f.db,f.id))!;
  assert.equal(job.state,"published");assert.equal(job.released_at,f.clock());assert.equal(f.screens(),1);
  assert.equal(cursor(f),3);assert.equal(f.publicStore.writes(),1);assert.equal(f.count("evidence"),1);
  assert.equal(publicationStatus(job).release_authorized,true);
  assert.equal(publicationStatus(job).download_url,`${f.options.artifactOrigin}/sha256/${f.digest}`);
  assert.deepEqual(f.sql.query("SELECT state FROM artifact_publication_audit ORDER BY seq").all().map((r:any)=>r.state),["queued","release-authorized","published"]);
});
for(const decision of ["quarantine","reject","allow-with-warning"] as const){
  test(`${decision} keeps this publication held, with no public PUT`,async()=>{
    const f=await queued();const normal=f.drainer.screen;
    const options={...f.drainer,screen:async(...args:Parameters<typeof normal>)=>({...await normal(...args),decision})};
    assert.equal(await deliverArtifactPublication(options,f.id),"held");
    const row=(await readPublicationJob(f.db,f.id))!;
    assert.equal(row.state,"held");assert.equal(row.released_at,null);assert.equal(f.publicStore.writes(),0);
    assert.equal(publicationStatus(row).download_url,null);assert.equal(cursor(f),2);
    assert.equal(await deliverArtifactPublication(options,f.id),"idle");
  });
}
test("provider outages have a bounded retry budget and never become publication passes",async()=>{
  const f=await queued();const normal=f.drainer.screen;
  const options={...f.drainer,screen:async(...args:Parameters<typeof normal>)=>({...await normal(...args),decision:"quarantine" as const,provider_status:"timeout" as const})};
  assert.equal(await deliverArtifactPublication(options,f.id),"retry");f.advance(60_000);
  assert.equal(await deliverArtifactPublication(options,f.id),"retry");f.advance(120_000);
  assert.equal(await deliverArtifactPublication(options,f.id),"held");
  assert.equal(f.screens(),3);assert.equal(f.publicStore.writes(),0);
});
test("a digest-mismatched provider result cannot authorize any byte release",async()=>{
  const f=await queued();const normal=f.drainer.screen;
  const options={...f.drainer,screen:async(...args:Parameters<typeof normal>)=>({...await normal(...args),evaluated_body_digest:`sha256:${"0".repeat(64)}`})};
  assert.equal(await deliverArtifactPublication(options,f.id),"retry");
  assert.equal((await readPublicationJob(f.db,f.id))!.state,"queued");assert.equal(f.publicStore.writes(),0);
});
test("evidence redaction during policy screening wins the release race",async()=>{
  const f=await queued();const normal=f.drainer.screen;
  const options={...f.drainer,screen:async(...args:Parameters<typeof normal>)=>{
    const r=await normal(...args);f.sql.exec("UPDATE event_content SET redacted_at='redacted' WHERE event_id='EV-1'");return r;
  }};
  assert.equal(await deliverArtifactPublication(options,f.id),"held");assert.equal(f.publicStore.writes(),0);
});
test("a stale screening lease cannot release a blob",async()=>{
  const f=await queued();const normal=f.drainer.screen;
  const options={...f.drainer,screen:async(...args:Parameters<typeof normal>)=>{
    const r=await normal(...args);f.sql.query("UPDATE artifact_publication_jobs SET lease_token=?").run("f".repeat(32));return r;
  }};
  assert.equal(await deliverArtifactPublication(options,f.id),"lost");assert.equal(f.publicStore.writes(),0);
});
test("competing drainers cannot duplicate a live policy invocation or public cursor movement",async()=>{
  const f=await queued();const results=await Promise.all(Array.from({length:12},()=>deliverArtifactPublication(f.drainer,f.id)));
  assert.equal(results.filter(r=>r==="published").length,1);assert.equal(f.screens(),1);assert.equal(f.publicStore.writes(),1);assert.equal(cursor(f),3);
});
test("a successful PUT with lost readback remains authorized and retries without rescreening",async()=>{
  const f=await queued();let fail=true;
  f.publicStore.hooks.get=()=>{if(fail)throw new Error("lost readback");};
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"retry");
  const row=(await readPublicationJob(f.db,f.id))!;
  assert.equal(row.state,"release-authorized");assert.equal(publicationStatus(row).release_authorized,true);
  assert.equal(publicationStatus(row).download_url,null);assert.equal(f.publicStore.writes(),1);assert.equal(cursor(f),2);
  // The committed owner intent is already irreversible, including after a
  // subsequent redaction. Do not relabel the uncertain R2 effect as private.
  f.sql.exec("UPDATE event_content SET redacted_at='redacted' WHERE event_id='EV-1'");
  fail=false;f.advance(60_000);
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"published");
  assert.equal(f.screens(),1);assert.equal(f.publicStore.writes(),1);assert.equal(cursor(f),3);
});
test("lease expiry after PUT leaves a recoverable delivery, not a false completion",async()=>{
  const f=await queued();let once=true;
  f.publicStore.hooks.put=()=>{if(once){once=false;f.advance(PUBLICATION_LEASE_MS+1);}};
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"lost");assert.equal(cursor(f),2);
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"published");assert.equal(cursor(f),3);assert.equal(f.screens(),1);
});
test("SQL forbids rollback of release authorization and mutation of binding identity",async()=>{
  const f=await queued();f.publicStore.hooks.get=()=>{throw new Error("readback unavailable");};
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"retry");
  assert.throws(()=>f.sql.exec("UPDATE artifact_publication_jobs SET state='held',released_at=NULL,screen_receipt_json=NULL"));
  assert.throws(()=>f.sql.exec("UPDATE artifact_publications SET sha256='bad'"));
  assert.throws(()=>f.sql.exec("DELETE FROM artifact_publications"));
  assert.throws(()=>f.sql.exec("DELETE FROM artifact_publication_audit"));
});
test("public corruption is never overwritten or silently certified as delivered",async()=>{
  const f=await queued();f.publicStore.data.set(`sha256/${f.digest}`,{bytes:f.bytes,httpMetadata:{contentType:"text/html"}});
  assert.equal(await deliverArtifactPublication(f.drainer,f.id),"retry");assert.equal(f.publicStore.writes(),0);
  assert.equal((await readPublicationJob(f.db,f.id))!.state,"release-authorized");assert.equal(cursor(f),2);
});
test("environment mismatches and aliased storage cannot send bytes to another destination",async()=>{
  const f=await queued();
  assert.equal(await deliverArtifactPublication({...f.drainer,artifactOrigin:"https://artifacts.asimposium.org"},f.id),"idle");
  await assert.rejects(deliverArtifactPublication({...f.drainer,publicBucket:f.privateStore.bucket},f.id));
  assert.equal(f.screens(),0);assert.equal(f.publicStore.writes(),0);
});
test("the bounded scheduled sweep discovers and finishes queued publications",async()=>{
  const f=await queued();
  assert.deepEqual(await drainArtifactPublications(f.drainer),{published:1,held:0,retry:0,lost:0,idle:0});
  assert.deepEqual(await drainArtifactPublications(f.drainer),{published:0,held:0,retry:0,lost:0,idle:0});
});

test("public manifests expose evidence-bound attachments, never private upload metadata",async()=>{
  const {readPublicArtifactManifest}=await import("../../src/krater/artifact-publication-read.ts");
  const f=await queued();
  await assert.rejects(readPublicArtifactManifest(f.db,f.options.artifactOrigin,f.problem,f.id),errorCode("NOT_FOUND"));
  await deliverArtifactPublication(f.drainer,f.id);
  const result=await readPublicArtifactManifest(f.db,f.options.artifactOrigin,f.problem,f.id);
  assert.equal(result.face.evidence.digest,`sha256:${f.evidenceDigest}`);
  assert.equal(result.face.artifact.download_url,`${f.options.artifactOrigin}/sha256/${f.digest}`);
  assert.equal(result.face.verification,"bytes-only");assert.equal(result.face.delivery_cursor,3);
  const text=JSON.stringify(result.face);
  for(const secret of [f.upload,f.actor.credentialId,"replay_ciphertext","screen_receipt_json","screening_sha256"])assert.equal(text.includes(secret),false);
});
test("redacted evidence and changed publication bodies cannot support public manifests",async()=>{
  const {readPublicArtifactManifest}=await import("../../src/krater/artifact-publication-read.ts");
  for(const mutation of ["redaction","body","private"]){
    const f=await queued();await deliverArtifactPublication(f.drainer,f.id);
    if(mutation==="redaction")f.sql.exec("UPDATE event_content SET redacted_at='gone' WHERE event_id='EV-1'");
    if(mutation==="body")f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(f.receipt.event_id);
    if(mutation==="private")f.sql.exec("UPDATE problems SET status='private-draft'");
    await assert.rejects(readPublicArtifactManifest(f.db,f.options.artifactOrigin,f.problem,f.id));
    assert.equal(f.publicStore.writes(),1); // moderation of a reference is not deletion of shared bytes
  }
});
test("delivery-order polling discovers an older request that finishes later",async()=>{
  const {readEvidenceArtifacts}=await import("../../src/krater/artifact-publication-read.ts");
  const f=await queued();const second=`AU-${"b".repeat(32)}`;
  f.sql.query("INSERT INTO artifact_uploads SELECT ?,fellow_id,sponsor_id,problem_id,state,sha256,size_bytes,encoding,content_type FROM artifact_uploads WHERE upload_id=?").run(second,f.upload);
  const r2=await requestArtifactPublication(f.options,f.actor,second,f.input,"second-request");
  await deliverArtifactPublication(f.drainer,r2.publication_id);
  const first=await readEvidenceArtifacts(f.db,f.options.artifactOrigin,f.problem,"E-1");
  assert.deepEqual(first.artifacts.map(x=>x.publication_id),[r2.publication_id]);
  await deliverArtifactPublication(f.drainer,f.id);
  const next=await readEvidenceArtifacts(f.db,f.options.artifactOrigin,f.problem,"E-1",first.through);
  assert.deepEqual(next.artifacts.map(x=>x.publication_id),[f.id]);
  assert.ok(next.artifacts[0]!.publication_event.seq < first.artifacts[0]!.publication_event.seq);
  assert.ok(next.artifacts[0]!.delivery_cursor > first.artifacts[0]!.delivery_cursor);
  const frozen=await readEvidenceArtifacts(f.db,f.options.artifactOrigin,f.problem,"E-1",0,first.through);
  assert.deepEqual(frozen.artifacts.map(x=>x.publication_id),[r2.publication_id]);
});
test("publication receipts remain byte-identical after eventual delivery",async()=>{
  const f=await queued();await deliverArtifactPublication(f.drainer,f.id);
  assert.deepEqual(await requestArtifactPublication(f.options,f.actor,f.upload,f.input,"publish-one"),f.receipt);
  assert.equal(cursor(f),3);assert.equal(f.reservations(),1);
});
test("malformed or future delivery cursors are not silently coerced",async()=>{
  const {readEvidenceArtifacts}=await import("../../src/krater/artifact-publication-read.ts");
  const f=await queued();await deliverArtifactPublication(f.drainer,f.id);
  for(const [after,through] of [[-1,3],[0,9007199254740991],[4,3],[0,1.5]])
    await assert.rejects(readEvidenceArtifacts(f.db,f.options.artifactOrigin,f.problem,"E-1",after,through),errorCode("CONFLICT"));
});
