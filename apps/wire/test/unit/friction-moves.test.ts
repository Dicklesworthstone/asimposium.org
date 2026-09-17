import { test } from "bun:test";
import assert from "node:assert/strict";
import type { NextMoveCandidate } from "@asimposium/contracts";
import { loadFrictionMove, withFrictionMove } from "../../src/mega-commands/friction-moves.ts";
import { frictionFixture, template } from "./friction-moves-fixture.ts";

test("a typed witness produces pinned private investigation, not invented counterevidence",async()=>{
  const f=frictionFixture();try{
    const claim=f.claim(1),report=f.report(2,claim);const result=await f.run();assert.ok(result.move);assert.equal(result.degraded,false);
    assert.deepEqual(result.move.refs,["P-DEMO","C-1@1","E-2"]);
    assert.deepEqual(result.move.contract.prefilled_hints,{type:"scratch"});
    assert.equal((result.move.contract.request as {path:string}).path,"/v1/sessions/{id}/workshop");
    const prep=result.move.contract.preparation as Record<string,any>;
    assert.equal(prep.friction_pin.event_id,report.publication.event_id);assert.equal(prep.target_pin.event_id,"EV-P-DEMO-1");
    assert.equal(prep.read_first.path,"/p/P-DEMO/formal.md?through=100&target=E-2");
    assert.equal(prep.publication_target_hints.direction,undefined);
    for(const sentinel of ["TOOLCHAIN-SENTINEL","OBLIGATION-SENTINEL","WITNESS-SENTINEL","ANALYSIS-SENTINEL"])
      assert.ok(!JSON.stringify(result.move).includes(sentinel));
  }finally{f.sqlite.close();}
});

test("canonical consequence ordering wins over report arrival and source volume",async()=>{
  const f=frictionFixture();try{
    const low=f.claim(1,"C-1",1,1),high=f.claim(3,"C-3",1,12);f.report(2,low);f.report(4,high);f.report(5,low);
    assert.equal((await f.run()).move?.refs[1],"C-3@1");
  }finally{f.sqlite.close();}
});

test("the oldest report wins a same-target tie without promoting repeated reports",async()=>{
  const f=frictionFixture();try{
    const claim=f.claim(1);f.report(8,claim);f.report(2,claim);assert.equal((await f.run()).move?.refs[2],"E-2");
  }finally{f.sqlite.close();}
});

for(const blocker of ["missing-hypothesis","definition-mismatch","tactic-only"] as const)
  test(`${blocker} is not misclassified as a counterexample trigger`,async()=>{
    const f=frictionFixture();try{f.report(2,f.claim(1),blocker);assert.deepEqual(await f.run(),{move:null,degraded:false});}
    finally{f.sqlite.close();}
  });

test("statement-too-strong is an investigation seed, not a conclusion of falsity",async()=>{
  const f=frictionFixture();try{f.report(2,f.claim(1),"statement-too-strong");assert.equal((await f.run()).move?.move,"add-refuter-from-friction");}
  finally{f.sqlite.close();}
});

for(const damage of ["redact-source","alter-source","remove-source","redact-claim","alter-claim","remove-claim","private","unlisted","retired"])
  test(`current source and target availability suppress ${damage}`,async()=>{
    const f=frictionFixture();try{
      const claim=f.claim(1),source=f.report(2,claim);const id=damage.includes("claim")?"EV-P-DEMO-1":source.publication.event_id;
      if(damage.startsWith("redact"))f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
      if(damage.startsWith("alter"))f.sqlite.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(id);
      if(damage.startsWith("remove"))f.sqlite.query("DELETE FROM event_content WHERE event_id=?").run(id);
      if(damage==="private")f.sqlite.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      if(damage==="unlisted")f.sqlite.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'");
      if(damage==="retired")f.sqlite.exec("UPDATE problems SET status='retired' WHERE id='P-DEMO'");
      const result=await f.run();assert.equal(result.move,null);assert.equal(result.degraded,true);
    }finally{f.sqlite.close();}
  });

test("new claim versions do not inherit an old version's witness",async()=>{
  const f=frictionFixture();try{
    const old=f.claim(1);f.report(2,old);f.claim(3,"C-1",2);assert.equal((await f.run()).move,null);
  }finally{f.sqlite.close();}
});

test("a changed head cannot retain a stale queue item's target",async()=>{
  const f=frictionFixture();try{
    const old=f.claim(1);f.report(2,old);f.claim(3,"C-1",2);f.items.splice(0,f.items.length,old);
    assert.deepEqual(await f.run(),{move:null,degraded:true});
  }finally{f.sqlite.close();}
});

test("later appends cannot rewrite a captured selection",async()=>{
  const f=frictionFixture();try{
    const old=f.claim(1);f.report(2,old);f.claim(101,"C-1",2);f.items.splice(0,f.items.length,old);
    assert.equal((await f.run()).move?.refs[1],"C-1@1");
  }finally{f.sqlite.close();}
});

for(const target of ["C-1","C-1@1","E-2","E-2@1"])test(`an authoritative withdrawal of ${target} excludes the witness task`,async()=>{
  const f=frictionFixture();try{
    const claim=f.claim(1);f.report(2,claim);
    f.event(9,"RET-9","retraction","object.retracted",{target_object:target},1,target.startsWith("C")?"F-author":"F-reporter");
    f.sqlite.query("INSERT INTO retractions VALUES('P-DEMO','RET-9',9,?)").run(target);
    assert.equal((await f.run()).move,null);
  }finally{f.sqlite.close();}
});

test("an unrelated Fellow's retraction cannot erase the target",async()=>{
  const f=frictionFixture();try{
    f.report(2,f.claim(1));f.event(9,"RET-9","retraction","object.retracted",{target_object:"C-1"},1,"F-other");
    f.sqlite.exec("INSERT INTO retractions VALUES('P-DEMO','RET-9',9,'C-1')");assert.ok((await f.run()).move);
  }finally{f.sqlite.close();}
});

test("same source ID in another problem cannot satisfy the bound target",async()=>{
  const f=frictionFixture();try{
    const r=f.report(2,f.claim(1));f.sqlite.query("UPDATE events SET problem_id='P-OTHER' WHERE id=?").run(r.publication.event_id);
    assert.equal((await f.run()).move,null);
  }finally{f.sqlite.close();}
});

test("unstructured historical prose and missing witnesses are omitted, never scraped",async()=>{
  for(const mode of ["prose","witness"]){const f=frictionFixture();try{
    const r=f.report(2,f.claim(1));const w=JSON.parse(r.content.body_md);
    if(mode==="witness")delete w.witness_seed;
    r.content.body_md=mode==="prose"?"counterexample-scent: just trust me":JSON.stringify(w);
    assert.deepEqual(await f.run(),{move:null,degraded:true});
  }finally{f.sqlite.close();}}
});

test("self-reported verified/confirmatory work cannot bypass the friction shape",async()=>{
  const f=frictionFixture();try{
    const r=f.report(2,f.claim(1));(r.content as any).direction="refutes";assert.equal((await f.run()).move,null);
  }finally{f.sqlite.close();}
});

test("ordinary admissions advance the bounded scan without hiding a second-page witness",async()=>{
  const f=frictionFixture();try{
    const c=f.claim(1);for(let seq=2;seq<10;seq++)f.admissions.push({seq,record:null});f.report(10,c);
    assert.equal((await f.run()).move?.refs[2],"E-10");assert.deepEqual(f.pages,[0,9]);
  }finally{f.sqlite.close();}
});

test("a witness beyond sixteen admissions is disclosed as bounded-out, not silently searched",async()=>{
  const f=frictionFixture();try{
    const c=f.claim(1);for(let seq=2;seq<19;seq++)f.admissions.push({seq,record:null});f.report(19,c);
    assert.deepEqual(await f.run(),{move:null,degraded:true});assert.equal(f.pages.length,2);assert.equal(f.calls.length,0);
  }finally{f.sqlite.close();}
});

test("scope mismatches and nonadvancing cursors fail rather than mixing snapshots",async()=>{
  const f=frictionFixture();try{
    f.report(2,f.claim(1));
    await assert.rejects(f.run({...f.dependencies,page:async(...args)=>({...await f.dependencies.page(...args),cursor:99})}),/PAGE_INVALID/);
    await assert.rejects(f.run({...f.dependencies,page:async(...args)=>({...await f.dependencies.page(...args),next_after:0})}),/CURSOR_INVALID/);
  }finally{f.sqlite.close();}
});

test("queue-empty and authority-filtered calls do not scan scientific bodies",async()=>{
  const f=frictionFixture();try{
    assert.deepEqual(await f.run(),{move:null,degraded:false});assert.equal(f.pages.length,0);
    let calls=0;const source={load:async()=>{calls++;return {move:null,degraded:false};}};
    f.claim(1);for(const denied of ["promote","workshop_push","session_open"]){
      const result=await withFrictionMove(f.db,"P-DEMO",100,f.items,{promote:true,workshop_push:true,session_open:true,[denied]:false},
        {moves:[],degraded:false},source);assert.equal(result.moves.length,0);
    }assert.equal(calls,0);
  }finally{f.sqlite.close();}
});

test("source failure preserves useful recommendations and seeded work replaces only duplicate generic refutation",async()=>{
  const f=frictionFixture();try{
    f.claim(1);const base={move:"add-refuter",refs:["P-DEMO","C-1@1"],why:"missing check",contract:{}} as NextMoveCandidate;
    const other={...base,move:"review" as const};const selected={moves:[base,other],degraded:false};
    const permissions={promote:true,workshop_push:true,session_open:true};
    const failed=await withFrictionMove(f.db,"P-DEMO",100,f.items,permissions,selected,{load:async()=>{throw new Error("PRIVATE-SQL");}});
    assert.deepEqual(failed,{moves:[base,other],degraded:true});
    const seed={...base,move:"add-refuter-from-friction" as const};
    const result=await withFrictionMove(f.db,"P-DEMO",100,f.items,permissions,selected,{load:async()=>({move:seed,degraded:false})});
    assert.deepEqual(result.moves,[seed,other]);
  }finally{f.sqlite.close();}
});

test("unavailable templates and fabricated source metadata create no actionable task",async()=>{
  const f=frictionFixture();try{
    const r=f.report(2,f.claim(1));
    assert.deepEqual(await f.run({...f.dependencies,template:()=>({...template,move:"review"})}),{move:null,degraded:true});
    r.publication.fellow_id="F-forged";assert.equal((await f.run()).move,null);
  }finally{f.sqlite.close();}
});
