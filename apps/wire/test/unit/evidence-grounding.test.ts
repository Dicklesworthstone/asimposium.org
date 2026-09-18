import assert from "node:assert/strict";
import { test } from "bun:test";
import { readEvidenceGrounding, EvidenceGroundingError, EVIDENCE_GROUNDING_NODE_LIMIT } from "../../src/ledger/evidence-grounding.ts";
import { withGroundingFixture } from "./evidence-grounding-fixture.ts";

const claim = {claimId:"C-1",version:1};
const check = (reason:string) => (error:unknown) => error instanceof EvidenceGroundingError && error.reason === reason;

test("resolves a shared dependency graph in one snapshot with exact commit witnesses", () => withGroundingFixture(async f => {
  const base = f.add("E-1"); const left = f.derived("E-2",[base]); const right = f.derived("E-3",[base],"method");
  const root = f.derived("E-4",[left,right]); const before = JSON.stringify(root);
  const result = await readEvidenceGrounding(f.db,"P-DEMO",claim,[root,right]);
  assert.deepEqual(result.roots.map(r=>r.evidenceId),["E-4","E-3"]);
  assert.equal(result.witnesses.length,4); assert.equal(f.calls(),1);
  assert.equal(result.witnesses[0]?.eventId,"event-E-1");
  assert.ok(result.witnesses.every(w=>w.problemId==="P-DEMO" && w.payloadJson.includes("body_md")));
  assert.equal(JSON.stringify(root),before);
}));

for (const field of ["check","method"] as const) test(`withdrawn ${field} ancestor cannot be laundered through a live derived record`, () => withGroundingFixture(async f => {
  const base=f.add("E-1"), middle=f.derived("E-2",[base],field), root=f.derived("E-3",[middle]);
  f.withdraw("E-1");
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("unavailable"));
}));

test("unrelated withdrawals do not invalidate a grounded route", () => withGroundingFixture(async f => {
  const base=f.add("E-1"), root=f.derived("E-2",[base]); f.add("E-3");f.withdraw("E-3");
  assert.equal((await readEvidenceGrounding(f.db,"P-DEMO",claim,[root])).roots.length,1);
}));

for (const mutation of ["redaction","missing","bytes","digest","cursor"] as const)
  test(`${mutation} of an ancestor refuses the whole read, not a partially verified root`, () => withGroundingFixture(async f => {
    const base=f.add("E-1"),root=f.derived("E-2",[base]);
    if(mutation==="redaction") f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='event-E-1'");
    if(mutation==="missing") f.sql.exec("DELETE FROM event_content WHERE event_id='event-E-1'");
    if(mutation==="bytes") f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='event-E-1'");
    if(mutation==="digest") f.sql.exec("UPDATE event_content SET payload_sha256='bad' WHERE event_id='event-E-1'");
    if(mutation==="cursor") f.sql.exec("UPDATE events SET seq=10001 WHERE id='event-E-1'");
    await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),EvidenceGroundingError);
}));

for (const extra of [{bears_on_id:"C-2"},{bears_on_version:2},{bears_on_kind:"hypothesis"},
  {mode:"exploratory"},{selected_hypothesis_id:"H-1"},{computed_class:"assertion"},{computed_class:"heuristic"}])
  test(`rejects a non-grounding ancestor ${JSON.stringify(extra)}`, () => withGroundingFixture(async f => {
    const base=f.add("E-1",extra),root=f.derived("E-2",[base]);
    await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("invalid"));
}));

test("cannot resolve another problem's evidence even with its exact digest", () => withGroundingFixture(async f => {
  const base=f.add("E-1",{},"P-OTHER"),root=f.derived("E-2",[base]);
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("unavailable"));
}));

test("a future dependency cannot be preseeded as valid grounding", () => withGroundingFixture(async f => {
  const base=f.add("E-1"),root=f.derived("E-2",[base]);f.sql.exec("UPDATE events SET seq=3 WHERE id='event-E-1'");
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("invalid"));
}));

test("a wrong edge digest cannot use the valid root of another requested graph", () => withGroundingFixture(async f => {
  const base=f.add("E-1"),root=f.derived("E-2",[{...base,digest:`sha256:${"0".repeat(64)}`}]);
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root,base]),EvidenceGroundingError);
}));

for (const pins of [[{evidence_id:"E-1"}],"E-1",[null],Array(17).fill({evidence_id:"E-1",digest:`sha256:${"0".repeat(64)}`})])
  test(`malformed pins cannot disappear from traversal ${JSON.stringify(pins).slice(0,60)}`, () => withGroundingFixture(async f => {
    const root=f.add("E-2",{falsification_check:{evidence:pins}});
    await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),EvidenceGroundingError);
}));

test("duplicate dependency pins are rejected rather than manufacturing independent inputs", () => withGroundingFixture(async f => {
  const base=f.add("E-1"),root=f.derived("E-2",[base,base]);
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("invalid"));
}));

test("free text and nested imitation keys are data, not traversable dependencies", () => withGroundingFixture(async f => {
  const root=f.add("E-1",{body_md:'{"scientific_provenance":{"method":{"evidence":[{"evidence_id":"E-missing"}]}}}',
    notes:{falsification_check:{evidence:[{evidence_id:"E-missing"}]}}});
  assert.equal((await readEvidenceGrounding(f.db,"P-DEMO",claim,[root])).witnesses.length,1);
}));

test("exact node budget succeeds and the next node refuses without extra round trips", () => withGroundingFixture(async f => {
  let root=f.add("E-1");
  for(let i=2;i<=EVIDENCE_GROUNDING_NODE_LIMIT;i++) root=f.derived(`E-${i}`,[root]);
  assert.equal((await readEvidenceGrounding(f.db,"P-DEMO",claim,[root])).witnesses.length,64);
  root=f.derived("E-65",[root]);
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("limit"));
  assert.equal(f.calls(),2);
}));

test("total bytes are bounded across the graph, not independently per source", () => withGroundingFixture(async f => {
  const pins=[1,2,3].map(n=>f.add(`E-${n}`,{body_md:"x".repeat(400000)}));
  const root=f.derived("E-4",pins);
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("limit"));
}));

test("oversized single sources never enter the hashing/JSON traversal input", () => withGroundingFixture(async f => {
  const root=f.add("E-1",{body_md:"x".repeat(524289)});
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("unavailable"));
}));

test("private and absent problems never return a readable root", () => withGroundingFixture(async f => {
  const root=f.add("E-1"); f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
  for(const problem of ["P-DEMO","P-MISSING"])
    await assert.rejects(readEvidenceGrounding(f.db,problem,claim,[root]),check("unavailable"));
}));

test("duplicate immutable object identities are refused rather than arbitrarily choosing one", () => withGroundingFixture(async f => {
  const root=f.add("E-1");
  f.sql.exec("INSERT INTO events SELECT 'duplicate',problem_id,2,type,object_kind,object_id,object_version,payload_sha256,actor_fellow_id,actor_sponsor_id FROM events");
  f.sql.exec("INSERT INTO event_content SELECT 'duplicate',payload_sha256,payload_json,NULL FROM event_content");
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root]),check("invalid"));
}));

test("empty roots cost no reads and duplicate/malformed roots fail before D1", () => withGroundingFixture(async f => {
  const root=f.add("E-1");
  assert.deepEqual(await readEvidenceGrounding(f.db,"P-DEMO",claim,[]),{roots:[],witnesses:[]});
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[root,root]),check("invalid"));
  await assert.rejects(readEvidenceGrounding(f.db,"P-DEMO",claim,[{...root,digest:"bad"}]),check("invalid"));
  assert.equal(f.calls(),0);
}));
