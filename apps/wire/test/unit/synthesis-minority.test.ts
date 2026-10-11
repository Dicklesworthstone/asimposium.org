import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { computeDroppedSingleAuthorCount } from "../../src/ledger/synthesis-minority.ts";

// Real SQLite, immutable event metadata and actual JSON field names. This
// exercises accounting SQL, not scientific verdicts or the publication gate.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,object_kind TEXT,
      object_id TEXT,type TEXT,actor_fellow_id TEXT,payload_sha256 TEXT);
    CREATE INDEX scope ON events(problem_id,seq);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    INSERT INTO problems VALUES ('P-COUNT',0,'active'),('P-OTHER',0,'active');`);
  let n = 0, queries = 0;
  const db = { prepare(query: string) { return { bind(...values: (string|number)[]) {
    return { first: async () => { queries++; return sql.query(query).get(...values) ?? null; } };
  } }; } } as unknown as D1Database;
  function event(kind: string, id: string, author: string | null = "F-1", payload: unknown = {},
    type = `${kind}.${kind === 'dead_end' ? 'recorded' : 'created'}`, problem = "P-COUNT") {
    const seq = ++n, eventId = `EV-${seq}`;
    const raw = JSON.stringify(payload), hash = createHash('sha256').update(raw).digest('hex');
    sql.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(eventId, problem, seq, kind, id, type, author, hash);
    sql.query('INSERT INTO event_content VALUES(?,?,?,NULL)').run(eventId, hash, raw);
    sql.query('UPDATE problems SET public_seq=? WHERE id=?').run(seq, problem);
    return seq;
  }
  const count = (ids: string[] = [], through = n) => computeDroppedSingleAuthorCount(db,"P-COUNT",through,ids);
  return { sql, event, count, db, get queries() { return queries; } };
}
async function using(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture(); try { await run(f); } finally { f.sql.close(); }
}

test('empty published scope has a real zero count', () => using(async f => {
  assert.equal(await f.count(), 0); assert.equal(f.queries, 1);
}));
test('counts unanchored claims, hypotheses and negative findings exactly once', () => using(async f => {
  f.event('claim','C-1'); f.event('hypothesis','H-1'); f.event('dead_end','DE-1');
  assert.equal(await f.count(), 3);
  assert.equal(await f.count(['C-1','DE-1']), 1);
  assert.equal(await f.count(['C-1','H-1','DE-1']), 0);
}));
test('revisions by one author remain one finding; multiple authors are not single-author', () => using(async f => {
  f.event('claim','C-1'); f.event('claim','C-1','F-1',{},'claim.revised');
  assert.equal(await f.count(), 1);
  f.event('claim','C-1','F-2',{},'claim.revised');
  assert.equal(await f.count(), 0);
}));
test('a killed route remains one negative finding, not two authored objects', () => using(async f => {
  f.event('hypothesis','H-1'); f.event('hypothesis','H-1','F-2',{},'hypothesis.killed');
  assert.equal(await f.count(), 1);
}));
test('duplicate or orphan publications do not manufacture findings', () => using(async f => {
  f.event('claim','C-1'); f.event('claim','C-1');
  f.event('claim','C-2','F-1',{},'claim.revised');
  f.event('claim','C-3',null); f.event('claim','C-4','');
  assert.equal(await f.count(), 0);
}));

const references: [string, string, string, unknown][] = [
  ['claim', 'review', 'review.created', { target_claim_id:'C-1', target_version:1 }],
  ['claim', 'evidence', 'evidence.created', { bears_on_kind:'claim', bears_on_id:'C-1' }],
  ['hypothesis', 'evidence', 'evidence.created', { bears_on_kind:'hypothesis', bears_on_id:'H-1' }],
  ['claim', 'relation', 'relation.asserted', { source:'C-1@1', target:'C-2@1' }],
  ['claim', 'relation', 'relation.asserted', { source:'C-2@1', target:'C-1@2' }],
  ['dead_end', 'dead_end', 'dead_end.recorded', { supersedes_dead_end_id:'DE-1' }],
  ['claim', 'claim', 'claim.created', { dependency_pins:[{claim_id:'C-1',version:1}] }],
  ['hypothesis', 'synthesis', 'synthesis.created', { anchors:[{target_kind:'hypothesis',target_id:'H-1'}] }],
];
const targetFor = (kind: string) => kind === 'claim' ? 'C-1' : kind === 'hypothesis' ? 'H-1' : 'DE-1';
for (const [targetKind, sourceKind, sourceType, payload] of references) {
  test(`counts actual ${sourceType} typed reference ${JSON.stringify(payload)}`, () => using(async f => {
    f.event(targetKind,targetFor(targetKind));
    f.event(sourceKind,'SOURCE-1','F-2',payload,sourceType);
    assert.equal(await f.count(['SOURCE-1']), 0);
    assert.equal(await f.count(['SOURCE-1'], 1), 1);
  }));
  test(`same-author ${sourceType} reference does not erase a minority finding ${JSON.stringify(payload)}`, () => using(async f => {
    f.event(targetKind,targetFor(targetKind));
    f.event(sourceKind,'SOURCE-1','F-1',payload,sourceType);
    assert.equal(await f.count(['SOURCE-1']), 1);
  }));
}
test('actual counterevidence counts as attention, not agreement', () => using(async f => {
  f.event('hypothesis','H-1');
  f.event('evidence','EV-1','F-2',{bears_on_kind:'hypothesis',bears_on_id:'H-1',direction:'refutes'});
  assert.equal(await f.count(), 0);
}));
test('projection-only or detached reviews cannot suppress a finding', () => using(async f => {
  f.event('claim','C-1');
  f.sql.exec("CREATE TABLE reviews(target_claim_id TEXT,reviewer_fellow_id TEXT); INSERT INTO reviews VALUES('C-1','F-2')");
  assert.equal(await f.count(), 1);
}));
test('reference scope and kind must match the finding', () => using(async f => {
  f.event('claim','C-1');
  f.event('review','R-1','F-2',{target_claim_id:'C-1'},'review.created','P-OTHER');
  f.event('evidence','E-1','F-2',{bears_on_kind:'hypothesis',bears_on_id:'C-1'});
  f.event('review','R-2','F-2',{target_claim_id:'C-1'},'review.draft');
  assert.equal(await f.count(), 1);
}));
test('unpublished references beyond the public cursor cannot change accounting', () => using(async f => {
  f.event('claim','C-1'); f.event('review','R-1','F-2',{target_claim_id:'C-1'});
  f.sql.exec("UPDATE problems SET public_seq=1 WHERE id='P-COUNT'");
  assert.equal(await f.count([],1),1);
  await assert.rejects(f.count([],2), /ACCOUNTING_UNAVAILABLE/);
}));
test('redacted or digest-detached reference bodies cannot suppress a finding', () => using(async f => {
  f.event('claim','C-1'); f.event('review','R-1','F-2',{target_claim_id:'C-1'});
  assert.equal(await f.count(),0);
  f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'");
  assert.equal(await f.count(),1);
  f.sql.exec("UPDATE event_content SET redacted_at=NULL,payload_sha256='detached' WHERE event_id='EV-2'");
  assert.equal(await f.count(),1);
}));
test('malformed JSON and non-object array members do not abort the aggregate', () => using(async f => {
  f.event('claim','C-1');
  f.event('synthesis','SYNTH-1','F-2',{anchors:['x',null,17]});
  f.event('claim','C-2','F-2',{dependency_pins:['x',null]});
  f.event('review','R-1','F-2',{});
  f.sql.exec("UPDATE event_content SET payload_json='invalid' WHERE event_id='EV-4'");
  assert.equal(await f.count(['C-2']),1);
}));
test('relation prefixes and invalid version suffixes do not count as citations', () => using(async f => {
  f.event('claim','C-1');
  for (const pin of ['C-10@1','C-1','C-1@0','C-1@01','C-1@x','C-1@1@2','C-1@'])
    f.event('relation',pin,'F-2',{source:'C-2@1',target:pin},'relation.asserted');
  assert.equal(await f.count(),1);
}));
test('duplicate references and duplicated supplied anchors do not multiply counts', () => using(async f => {
  f.event('claim','C-1'); f.event('claim','C-2');
  f.event('synthesis','SYNTH-1','F-2',{anchors:[{target_kind:'claim',target_id:'C-1'},{target_kind:'claim',target_id:'C-1'}]});
  assert.equal(await f.count(),1);
  assert.equal(await f.count(['C-2','C-2']),0);
}));
test('private or missing problems refuse instead of returning a fabricated zero', () => using(async f => {
  f.event('claim','C-1'); f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-COUNT'");
  await assert.rejects(f.count(), /ACCOUNTING_UNAVAILABLE/);
  await assert.rejects(computeDroppedSingleAuthorCount(f.db,'P-MISSING',0,[]), /ACCOUNTING_UNAVAILABLE/);
}));
test('large populated ledger needs one query, not two lookups per finding', () => using(async f => {
  f.sql.exec('BEGIN');
  for (let i=1;i<=1000;i++) f.event('claim',`C-${i}`);
  for (let i=1;i<=500;i++) f.event('review',`R-${i}`,'F-2',{target_claim_id:`C-${i}`});
  f.sql.exec('COMMIT');
  assert.equal(await f.count(),500); assert.equal(f.queries,1);
  assert.equal(await f.count(Array.from({length:1000},(_,i)=>`C-${i+1}`)),0);
  assert.equal(f.queries,2);
}));
test('unusable database result fails rather than claiming no minority findings', async () => {
  const db={prepare(){return {bind(){return {first:async()=>({count:0})};}};}} as unknown as D1Database;
  await assert.rejects(computeDroppedSingleAuthorCount(db,'P-COUNT',0,[]), /ACCOUNTING_UNAVAILABLE/);
});
test('invalid windows and huge anchor input fail before query work', () => using(async f => {
  for (const n of [-1,0.5,Infinity,NaN])
    await assert.rejects(computeDroppedSingleAuthorCount(f.db,'P-COUNT',n,[]));
  await assert.rejects(computeDroppedSingleAuthorCount(f.db,'P-COUNT',0,Array(1001).fill('C-1')));
  assert.equal(f.queries,0);
}));
