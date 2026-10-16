import { test } from "bun:test";
import assert from "node:assert/strict";
import { HYPOTHESIS_CONTENT_BYTES, HypothesisReadError } from "../../src/ledger/hypotheses-read.ts";
import { hypothesisHistoryFixture } from "../support/hypothesis-history-fixture.ts";

const killed = { killedOnly: true };

test("negative-history selection reaches eliminations beyond hundreds of live admissions in one batch", async () => {
  const f = hypothesisHistoryFixture();
  try {
    for (let seq = 1; seq <= 201; seq++) f.event(seq);
    f.event(202,"H-201","hypothesis.killed");
    const page = await f.read({},killed);
    assert.deepEqual(page?.face.hypotheses.map(h => h.hypothesis_id),["H-201"]);
    assert.equal(page?.face.hypotheses[0]?.content?.route,"Published route H-201");
    assert.equal(page?.face.hypotheses[0]?.status,"killed");
    assert.deepEqual(f.counts(),{batches:1,rows:2});
    assert.equal(f.queries.length,2);
    assert.ok(!f.queries.some(q => /FROM hypotheses\b/.test(q)));
    assert.ok(!JSON.stringify(page).includes("PROJECTION-POISON"));
  } finally { f.sql.close(); }
});

test("negative history pages preserve a finite cut, whole records and admission order", async () => {
  const f = hypothesisHistoryFixture();
  try {
    for (let seq = 1; seq <= 21; seq++) f.event(seq);
    for (let i = 1; i <= 10; i++) f.event(21+i,`H-${i*2}`,"hypothesis.killed");
    const first = (await f.read({},killed))!.face;
    assert.equal(first.hypotheses.length,8);
    assert.equal(first.next_after,16);
    assert.deepEqual(first.omitted,["page_limit"]);
    f.event(32,"H-1","hypothesis.killed");
    const last = (await f.read({through:first.cursor,after:first.next_after!},killed))!.face;
    assert.deepEqual(last.hypotheses.map(h => h.hypothesis_id),["H-18","H-20"]);
    assert.equal(last.next_after,null);
    assert.equal(last.cursor,31);
    assert.deepEqual(f.counts(),{batches:2,rows:13});
    assert.deepEqual((await f.read({through:21},killed))?.face.hypotheses,[]);
  } finally { f.sql.close(); }
});

test("creation and elimination retain their own actor snapshots and bytes", async () => {
  const f = hypothesisHistoryFixture();
  try {
    f.event(1); f.event(2,"H-1","hypothesis.killed");
    const h = (await f.read({},killed))!.face.hypotheses[0]!;
    assert.equal(h.publication.fellow_id,"F-AUTHOR");
    assert.equal(h.last_event.fellow_id,"F-KILLER");
    assert.equal(h.publication.sponsor_id,"SP-AUTHOR");
    assert.equal(h.last_event.sponsor_id,"SP-KILLER");
    assert.equal(h.content?.body_md,"Original work product for H-1");
    assert.equal(h.kill?.killed_by_evidence_id,"E-1");
    assert.notEqual(h.publication.payload_sha256,h.last_event.payload_sha256);
  } finally { f.sql.close(); }
});

test("an unknown lifecycle after elimination remains an explicit negative-history admission", async () => {
  const f = hypothesisHistoryFixture();
  try {
    f.event(1); f.event(2,"H-1","hypothesis.killed"); f.event(3,"H-1","hypothesis.future-transition");
    const result = (await f.read({},killed))!.face;
    assert.equal(result.hypotheses.length,1);
    assert.equal(result.hypotheses[0]?.status,"unavailable");
    assert.equal(result.hypotheses[0]?.kill,null);
    assert.ok(result.omitted.includes("lifecycle_unavailable"));
    assert.equal((await f.read({through:2},killed))!.face.hypotheses[0]?.status,"killed");
  } finally { f.sql.close(); }
});

for (const selection of [{}, {liveOnly:true}, killed, {target:"H-1"}]) {
  test(`all hypothesis entry points respect whole-problem hiding and restoration: ${JSON.stringify(selection)}`, async () => {
    const f = hypothesisHistoryFixture();
    try {
      f.event(1); f.event(2,"H-1","hypothesis.killed");
      f.control("problem","hidden");
      assert.equal(await f.read({through:2},selection),null);
      f.control("problem","visible");
      const result = await f.read({through:2},selection);
      assert.ok(result);
      assert.equal(result.face.hypotheses.length,"liveOnly" in selection ? 0 : 1);
      f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      assert.equal(await f.read({},selection),null);
    } finally { f.sql.close(); }
  });
}

for (const target of ["H-1","H-1@1","#1","#2"]) {
  for (const selection of [{},killed]) {
    test(`current control ${target} withholds only its applicable content without dropping pagination: ${JSON.stringify(selection)}`, async () => {
      const f = hypothesisHistoryFixture();
      try {
        f.event(1); f.event(2,"H-1","hypothesis.killed");
        f.control(target,"hidden");
        const page = (await f.read({through:2},selection))!.face;
        const h = page.hypotheses[0]!;
        assert.equal(page.hypotheses.length,1);
        assert.equal(h.status,"killed");
        assert.equal(h.content === null,target !== "#2");
        assert.equal(h.kill === null,target !== "#1");
        assert.ok(page.omitted.includes("content_unavailable"));
        f.control(target,"visible");
        const restored = (await f.read({through:2},selection))!.face;
        assert.ok(restored.hypotheses[0]?.content);
        assert.ok(restored.hypotheses[0]?.kill);
        assert.deepEqual(restored.omitted,[]);
      } finally { f.sql.close(); }
    });
  }
}

test("an unavailable active route stays counted and cannot manufacture a two-route frontier", async () => {
  const f = hypothesisHistoryFixture();
  try {
    f.event(1); f.event(2); f.event(3); f.control("H-2","hidden");
    const page = (await f.read({}, {liveOnly:true,limit:3}))!.face;
    assert.equal(page.hypotheses.length,3);
    assert.equal(page.hypotheses[1]?.content,null);
    assert.ok(page.omitted.includes("content_unavailable"));
  } finally { f.sql.close(); }
});

for (const which of ["publication","kill"] as const) for (const damage of ["redacted","missing","detached","tampered","oversized"] as const) {
  test(`elimination survives as an unavailable record when ${which} is ${damage}`, async () => {
    const f = hypothesisHistoryFixture();
    try {
      const creation=f.event(1), end=f.event(2,"H-1","hypothesis.killed");
      const id=which === "publication" ? creation : end;
      if (damage === "redacted") f.sql.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
      if (damage === "missing") f.sql.prepare("DELETE FROM event_content WHERE event_id=?").run(id);
      if (damage === "detached") f.sql.prepare("UPDATE event_content SET payload_sha256=? WHERE event_id=?").run("f".repeat(64),id);
      if (damage === "tampered") f.sql.prepare("UPDATE event_content SET payload_json=payload_json || ' ' WHERE event_id=?").run(id);
      if (damage === "oversized") {
        const body=JSON.stringify({route:"oversized",body_md:"x".repeat(HYPOTHESIS_CONTENT_BYTES)});
        f.sql.prepare("UPDATE event_content SET payload_json=?,payload_sha256=? WHERE event_id=?").run(body,f.sha(body),id);
        f.sql.prepare("UPDATE events SET payload_sha256=? WHERE id=?").run(f.sha(body),id);
      }
      const page=(await f.read({},killed))!.face, h=page.hypotheses[0]!;
      assert.equal(h.status,"killed");
      assert.equal(which === "publication" ? h.content : h.kill,null);
      assert.ok(page.omitted.includes("content_unavailable"));
      assert.equal((await f.read({}, {liveOnly:true}))!.face.hypotheses.length,0);
    } finally { f.sql.close(); }
  });
}

test("same local ids and controls in another problem do not cross the scope boundary", async () => {
  const f = hypothesisHistoryFixture();
  try {
    f.event(1); f.event(2,"H-1","hypothesis.killed");
    f.event(1,"H-1","hypothesis.created",{route:"OTHER-PROBLEM-CANARY"},"P-OTHER");
    f.control("H-1","hidden","P-OTHER"); f.control("problem","hidden","P-OTHER");
    f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'");
    const result=await f.read({},killed);
    assert.equal(result?.unlisted,true);
    assert.ok(result?.face.hypotheses[0]?.content);
    assert.ok(!JSON.stringify(result).includes("OTHER-PROBLEM-CANARY"));
  } finally { f.sql.close(); }
});

for (const selection of [
  {liveOnly:true,killedOnly:true}, {killedOnly:"yes"}, {liveOnly:1},
  {target:"H-1",killedOnly:false}, {target:"H-1",killedOnly:true},
]) test(`invalid internal selection is refused before I/O: ${JSON.stringify(selection)}`, async () => {
  const f=hypothesisHistoryFixture();
  try {
    await assert.rejects(f.read({},selection as Parameters<typeof f.read>[1]),
      (error: unknown) => error instanceof HypothesisReadError && error.code === "CURSOR_INVALID");
    assert.equal(f.queries.length,0);
  } finally { f.sql.close(); }
});

test("duplicate creation and wrong kill target never turn an ambiguous history into a clean elimination", async () => {
  const f=hypothesisHistoryFixture();
  try {
    f.event(1);f.event(2,"H-1");f.event(3,"H-1","hypothesis.killed");
    f.event(4,"H-2");f.event(5,"H-2","hypothesis.killed",{hypothesis_id:"H-99"});
    assert.deepEqual((await f.read({},killed))!.face.hypotheses.map(h=>h.status),["unavailable","unavailable"]);
  } finally { f.sql.close(); }
});
