import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { promotionScreeningBinding } from "../../src/screening/workers-ai.ts";
import type { WithdrawalKind, WithdrawalOptions, WithdrawalRequest } from "../../src/ledger/scientific-withdrawals.ts";

export const NOW = Date.parse("2026-09-17T12:00:00.000Z");
export const SESSION = `S-${"A".repeat(26)}`;
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const iso = (t = NOW) => new Date(t).toISOString();

/** Actual migration, SQL and service, but modeled parent identity tables and
 * writer/quota/screen ports. This is a unit fixture, not D1 integration. */
export function withdrawalFixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY,cursor INTEGER);
    INSERT INTO public_cursor VALUES(1,0);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY,sponsor_id TEXT,status TEXT);
    CREATE TABLE enrollment_grants(fellow_id TEXT PRIMARY KEY,sponsor_id TEXT,granted_scopes_json TEXT,granted_resources_json TEXT);
    CREATE TABLE fellow_tokens(credential_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,
      granted_scopes_json TEXT,granted_resources_json TEXT,issued_at INTEGER,expires_at INTEGER,revoked_at INTEGER,credential_profile TEXT);
    CREATE TABLE enrollment_sponsor_security(sponsor_id TEXT PRIMARY KEY,panic_at INTEGER);
    CREATE TABLE sessions(session_id TEXT PRIMARY KEY,fellow_id TEXT,problem_id TEXT,opened_at TEXT,idle_close_at TEXT,closed_at TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT,PRIMARY KEY(problem_id,fellow_id));
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,object_version INTEGER,
      payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,writer_credential_id TEXT,created_at TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE claims(problem_id TEXT,id TEXT,source_seq INTEGER);
    CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,content_digest TEXT,statement TEXT,kind TEXT);
    CREATE TABLE claim_deps(problem_id TEXT,claim_id TEXT,depends_on_claim_id TEXT);
    CREATE TABLE reviews(problem_id TEXT,review_id TEXT,source_event_id TEXT,source_seq INTEGER,reviewer_fellow_id TEXT,
      target_claim_id TEXT,target_version INTEGER,verdict TEXT,capable_of_failure TEXT);
    CREATE TABLE evidence(problem_id TEXT,evidence_id TEXT,source_event_id TEXT,source_seq INTEGER,author_fellow_id TEXT,
      bears_on_kind TEXT,bears_on_id TEXT,bears_on_version INTEGER,direction TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT,retraction_kind TEXT,
      reason TEXT,author_fellow_id TEXT,created_at TEXT,PRIMARY KEY(problem_id,retraction_id));
    CREATE TABLE public_write_attempt_reservations(reservation_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,problem_id TEXT,
      session_id TEXT,route TEXT,idempotency_key TEXT,request_digest TEXT,reserved_at INTEGER,expires_at INTEGER,status TEXT,settled_at INTEGER,
      UNIQUE(fellow_id,route,idempotency_key));`);
  sql.exec(readFileSync(new URL("../../../../db/migrations/0071_scientific_withdrawals.sql", import.meta.url), "utf8"));
  const actor: FellowCredentialBinding = { fellowId:"fellow-a",sponsorId:"sponsor-a",credentialId:"token-a",
    name:"Tester",model:"declared",harness:"test",tokenHash:"unused-test-hash",grantedScopes:["promote","review"],
    grantedResources:{eventBudget:100},issuedAt:NOW-10000,expiresAt:NOW+3600000,
    credentialProfile:"bearer",fellowStatus:"active" };
  const scopes=JSON.stringify(actor.grantedScopes), resources=JSON.stringify(actor.grantedResources);
  sql.query("INSERT INTO enrollment_fellows VALUES(?,?,'active')").run(actor.fellowId,actor.sponsorId);
  sql.query("INSERT INTO enrollment_grants VALUES(?,?,?,?)").run(actor.fellowId,actor.sponsorId,scopes,resources);
  sql.query("INSERT INTO fellow_tokens VALUES(?,?,?,?,?,?,?,NULL,'bearer')")
    .run(actor.credentialId,actor.fellowId,actor.sponsorId,scopes,resources,actor.issuedAt,actor.expiresAt);
  sql.query("INSERT INTO sessions VALUES(?,?,?, ?,?,NULL)").run(SESSION,actor.fellowId,"P-DEMO",iso(NOW-5000),iso(NOW+300000));
  sql.query("INSERT INTO problem_memberships VALUES('P-DEMO',?,'contributor')").run(actor.fellowId);
  function prepare(text: string) {
    let values: unknown[]=[];
    const execute=()=>({success:true,results:sql.query(text).all(...values as (string|number|null)[]),
      meta:{changes:(sql.query("SELECT changes() AS n").get() as {n:number}).n}});
    return {bind(...v:unknown[]){values=v;return this},async first(){return execute().results[0]??null},
      async all(){return execute()},async run(){return execute()},execute};
  }
  const db={prepare,async batch(statements:ReturnType<typeof prepare>[]){
    sql.exec("BEGIN");try{const results=statements.map(s=>s.execute());sql.exec("COMMIT");return results}
    catch(e){sql.exec("ROLLBACK");throw e}
  }} as unknown as D1Database;
  let now=NOW, beforeWrite:(()=>void)|undefined, failAfter=false;
  const counts={screens:0,reservations:0,writes:0,settlements:0};
  const append=(id:string,type:string,kind:string,object:string,payload:unknown,author="fellow-a",problem="P-DEMO",version=1)=>{
    const content=JSON.stringify(payload), digest=sha(content);
    const seq=(sql.query("SELECT public_seq + 1 AS n FROM problems WHERE id=?").get(problem) as {n:number}).n;
    sql.query("UPDATE problems SET public_seq=? WHERE id=?").run(seq,problem);
    sql.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,problem,seq,type,kind,object,version,digest,author,author==="fellow-a"?"sponsor-a":"sponsor-b",SESSION,null,iso(now));
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id,digest,content);
    return {id,seq,digest,content};
  };
  append("E-claim","claim.created","claim","C-1",{claim_id:"C-1",statement:"Every n has the stated bound."},"fellow-b");
  sql.exec("INSERT INTO claims VALUES('P-DEMO','C-1',1)");
  sql.query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',1,?,?, 'conjecture')")
    .run(`sha256:${sha("statement")}`,"Every n has the stated bound.");
  const source=(kind:WithdrawalKind,id=kind==="review"?"REV-one":"E-one",extra:Record<string,unknown>={},author="fellow-a")=>{
    const payload:Record<string,unknown>=kind==="review"?{target_claim_id:"C-1",target_version:1,verdict:"confirm",capable_of_failure:"Check n=0.",
      tier:"T1",independence_policy:"declared-family-and-grounded-method-v1",...extra}
      :{bears_on_kind:"claim",bears_on_id:"C-1",bears_on_version:1,direction:"supports",kind:"computation",
        mode:"confirmatory",computed_class:"numerical",body_md:"Deliberate public work product.",...extra};
    const event=append(`source-${id}`,`${kind}.created`,kind,id,payload,author);
    if(kind==="review") sql.query("INSERT INTO reviews VALUES('P-DEMO',?,?,?,?,?,?,?,?)")
      .run(id,event.id,event.seq,author,"C-1",1,String(payload.verdict),String(payload.capable_of_failure));
    else sql.query("INSERT INTO evidence VALUES('P-DEMO',?,?,?,?,'claim','C-1',1,?)")
      .run(id,event.id,event.seq,author,String(payload.direction));
    const request:WithdrawalRequest={source_event_id:event.id,source_digest:`sha256:${event.digest}`,reason:"An assumption in my recorded work does not hold."};
    return {event,request,id,kind};
  };
  const options:WithdrawalOptions={db,clock:()=>now,
    async reserve(input){
      const prior=sql.query("SELECT reservation_id,request_digest FROM public_write_attempt_reservations WHERE fellow_id=? AND route=? AND idempotency_key=?")
        .get(input.fellowId,input.route,input.idempotencyKey) as {reservation_id:string;request_digest:string}|null;
      if(prior){if(prior.request_digest!==input.requestDigest)throw new Error("reservation conflict");return prior.reservation_id}
      counts.reservations++;const id=crypto.randomUUID();
      sql.query("INSERT INTO public_write_attempt_reservations VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',NULL)")
        .run(id,input.fellowId,input.sponsorId,input.problemId,input.sessionId,input.route,input.idempotencyKey,input.requestDigest,now,now+60000);
      return id;
    },
    async settleFailure(id,held){counts.settlements++;sql.query("UPDATE public_write_attempt_reservations SET status=? WHERE reservation_id=? AND status='reserved'")
      .run(held?"settled_held":"settled_failed",id)},
    async screen(input){counts.screens++;const binding=await promotionScreeningBinding(input);return {
      example_id:"unit",evaluated_body_digest:binding.bodyDigest,evaluated_context_digest:binding.contextDigest,
      decision:"pass",provider_status:"ok",model_version:"unit-model",policy_version:"unit-policy",configuration_digest:`sha256:${"1".repeat(64)}`,
      coarse_category:"benign-context",category_score_bands:{} as never,decision_path:"provider",status_code:"SCREENED",latency_ms:0,retry_count:0,
    }},
    async writeLedger(input,projection){
      counts.writes++;const hook=beforeWrite;beforeWrite=undefined;hook?.();
      let committed=false;
      sql.exec("BEGIN");try{
        const valid=sql.query(`SELECT 1 FROM problems WHERE id=? ${projection.preconditionSql??""}`)
          .get(input.problemId,...projection.preconditionBindings as (string|number|null)[]);
        if(!valid)throw new Error("source changed");
        const event=append(input.eventId,input.eventType,input.objectKind,input.objectId,JSON.parse(input.payloadJson),input.attribution.fellowId!,input.problemId);
        sql.query("UPDATE events SET writer_credential_id=?,actor_session_id=?,actor_sponsor_id=?,created_at=? WHERE id=?")
          .run(input.attribution.credentialId!,input.attribution.sessionId,input.attribution.sponsorId,input.createdAt,input.eventId);
        const prepared=projection.statementsAfterEvent({eventId:input.eventId,sequence:event.seq,objectId:input.objectId,payloadSha256:event.digest});
        const statements=Array.isArray(prepared)?prepared:await prepared;
        for(const statement of statements)(statement as unknown as ReturnType<typeof prepare>).execute();
        sql.exec("COMMIT");
        committed=true;
        if(failAfter){failAfter=false;throw new Error("lost committed acknowledgment")}
        return {eventId:input.eventId,seq:event.seq};
      }catch(error){if(!committed)sql.exec("ROLLBACK");throw error}
    },
  };
  return {sql,db,actor,source,append,options,counts,clock:(value:number)=>{now=value},
    before:(hook:()=>void)=>{beforeWrite=hook},loseAcknowledgment:()=>{failAfter=true},
    close:()=>sql.close()};
}
