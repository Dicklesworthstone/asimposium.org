import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import type { MoveTemplate } from "@asimposium/contracts";
import type { FrictionWork } from "@asimposium/contracts/formalization-friction";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { FormalRecord, FormalRecordRead } from "../../src/ledger/formal-records.ts";
import { loadFrictionMove, type FrictionMoveDependencies } from "../../src/mega-commands/friction-moves.ts";

export const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export const template: MoveTemplate={move:"add-refuter-from-friction",title:"Refute from friction",
  trigger:"A structured mathematical blocker",description:"Investigate a witness",
  availability:"available",target_contract:"/schemas/sessions.v1.json#/properties/evidence_request",
  request:{method:"POST",path:"/v1/sessions/{id}/evidence",auth:"fellow-bearer",idempotency_key_required:true},
  required_fields:["body_md"],prefilled_hints:{direction:"refutes"}};
export function frictionFixture(){
  const sqlite=new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT);
    INSERT INTO problems VALUES('P-DEMO',100,'active',0),('P-OTHER',100,'active',0);`);
  const calls:string[]=[], pages:number[]=[], items:ReviewQueueItem[]=[], admissions:{seq:number;record:FormalRecord|null}[]=[];
  const db={prepare(sql:string){let values:unknown[]=[];return{
    bind(...v:unknown[]){values=v;return this;},
    async all(){calls.push(sql);return {results:sqlite.query(sql).all(...values as never[])};},
    async first(){calls.push(sql);return sqlite.query(sql).get(...values as never[])??null;},
  };}} as D1Database;
  function event(seq:number,object:string,kind:string,type:string,body:Record<string,unknown>,version=1,fellow="F-author",problem="P-DEMO"){
    const text=JSON.stringify(body),eventId=`EV-${problem}-${seq}`;
    sqlite.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)").run(eventId,problem,seq,type,kind,object,version,hash(text),fellow,`SP-${fellow}`);
    sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId,hash(text),text);
    return {event_id:eventId,object_id:object,seq,payload_sha256:hash(text),fellow_id:fellow,sponsor_id:`SP-${fellow}`,
      session_id:"SS-example",model_string_self_declared:"model",harness:"harness",created_at:"2026-09-17T00:00:00.000Z"};
  }
  function claim(seq:number,id=`C-${seq}`,version=1,dependents=1){
    event(seq,id,"claim",version===1?"claim.created":"claim.revised",{claim_id:id,kind:"lemma",statement:`Statement of ${id}@${version}`,
      falsifier:"A counterexample in the stated domain.",...(version===1?{}:{base_version:version-1})},version);
    const item:ReviewQueueItem={problem_id:"P-DEMO",claim_id:id,version,cursor:100,kind:"lemma",statement:`Statement of ${id}@${version}`,
      falsifier:"A counterexample in the stated domain.",disposition:"disputed",need:"resolve-dispute",best_recorded_tier:"none",
      direct_dependents:dependents,dependents_capped:false,author_fellow_id:"F-author",author_sponsor_id:"SP-F-author",
      created_at:"2026-09-17T00:00:00.000Z",read_url:`/p/P-DEMO/claims/${id}@${version}.md?through=100`};
    const old=items.findIndex(x=>x.claim_id===id);if(old>=0)items.splice(old,1);
    items.push(item);return item;
  }
  function report(seq:number,target:ReviewQueueItem,blocker:FrictionWork["blocker"]="counterexample-scent"){
    const work:FrictionWork={format:"asimposium.formalization-friction.v1",blocker,toolchain:"TOOLCHAIN-SENTINEL",
      blocked_obligation:"OBLIGATION-SENTINEL: nonzero denominator",witness_seed:"WITNESS-SENTINEL: boundary at zero",
      analysis:"ANALYSIS-SENTINEL: the attempt assumes a missing regularity condition."};
    const content={bears_on_kind:"claim" as const,bears_on_id:target.claim_id,bears_on_version:target.version,
      direction:"informs" as const,kind:"formalization-friction" as const,source:{kind:"model_memory" as const},
      mode:"exploratory" as const,body_md:JSON.stringify(work)};
    const publication=event(seq,`E-${seq}`,"evidence","evidence.created",content,1,"F-reporter");
    const record:FormalRecord={kind:"formalization-friction",publication,target:{claim_id:target.claim_id,version:target.version},content};
    admissions.push({seq,record});return record;
  }
  // Canonical formal-page and scientific-queue outputs are explicit fixtures.
  // SQL binding/hashing below are real. These are not a full evaluator/Zod proof.
  const dependencies:FrictionMoveDependencies={
    async page(_db,_problem,cursor,after){
      pages.push(after);const selected=admissions.filter(x=>x.seq>after&&x.seq<=cursor).sort((a,b)=>a.seq-b.seq);
      return {problem_id:"P-DEMO",cursor,after,target:null,unlisted:false,
        records:selected.slice(0,8).flatMap(x=>x.record?[x.record]:[]),
        next_after:selected.length>8?selected[7]!.seq:null,omitted:selected.length>8?["page_limit"]:[]} as FormalRecordRead;
    },
    work(body){try {const w=JSON.parse(body);return w?.format==="asimposium.formalization-friction.v1"?w:null;}catch{return null;}},
    template:()=>template,
  };
  return {sqlite,db,calls,pages,items,admissions,dependencies,claim,report,event,
    run:(d=dependencies)=>loadFrictionMove(db,"P-DEMO",100,items,d),
    updateBody(id:string,body:Record<string,unknown>,commitDigest=false){
      const text=JSON.stringify(body);sqlite.query("UPDATE event_content SET payload_json=? WHERE event_id=?").run(text,id);
      if(commitDigest){sqlite.query("UPDATE events SET payload_sha256=? WHERE id=?").run(hash(text),id);
        sqlite.query("UPDATE event_content SET payload_sha256=? WHERE event_id=?").run(hash(text),id);}
    },
  };
}
