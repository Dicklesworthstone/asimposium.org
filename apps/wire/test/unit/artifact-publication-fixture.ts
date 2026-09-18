import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { artifactSha256 } from "../../src/krater/artifact-inspection.ts";
import { publicationHash, type PublicationCommandOptions } from "../../src/krater/artifact-publication-store.ts";
import { publicationScreenContext, type PublicationDrainerOptions } from "../../src/krater/artifact-publication-outbox.ts";

/** Actual new migration/queries, modeled parent tables and a serialized ledger
 * port. This fixture does NOT stand in for real D1/R2 or full-chain integration. */
export async function publicationFixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys = ON;
  CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY,sponsor_id TEXT,status TEXT);
  CREATE TABLE enrollment_grants(fellow_id TEXT PRIMARY KEY,sponsor_id TEXT,granted_scopes_json TEXT,granted_resources_json TEXT);
  CREATE TABLE fellow_tokens(credential_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,issued_at INTEGER,expires_at INTEGER,
    revoked_at INTEGER,credential_profile TEXT,granted_scopes_json TEXT,granted_resources_json TEXT);
  CREATE TABLE enrollment_sponsor_security(sponsor_id TEXT PRIMARY KEY,panic_at INTEGER);
  CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT,unlisted INTEGER,public_seq INTEGER);
  CREATE TABLE sessions(session_id TEXT PRIMARY KEY,fellow_id TEXT,problem_id TEXT,opened_at TEXT,idle_close_at TEXT,closed_at TEXT);
  CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT,PRIMARY KEY(problem_id,fellow_id));
  CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,object_version INTEGER,
    payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,writer_credential_id TEXT,created_at TEXT,
    UNIQUE(problem_id,seq));
  CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
  CREATE TABLE evidence(problem_id TEXT,evidence_id TEXT,author_fellow_id TEXT,PRIMARY KEY(problem_id,evidence_id));
  CREATE TABLE artifact_uploads(upload_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,problem_id TEXT,state TEXT,
    sha256 TEXT,size_bytes INTEGER,encoding TEXT,content_type TEXT);
  CREATE TABLE public_write_attempt_reservations(reservation_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,problem_id TEXT,
    session_id TEXT,route TEXT,idempotency_key TEXT,request_digest TEXT,reserved_at INTEGER,expires_at INTEGER,status TEXT,settled_at INTEGER,
    UNIQUE(fellow_id,route,idempotency_key));
  CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY,cursor INTEGER);
  INSERT INTO public_cursor VALUES(1,1);
  CREATE TABLE idempotency(problem_id TEXT,idempotency_key TEXT,request_digest TEXT,event_id TEXT,event_seq INTEGER,
    PRIMARY KEY(problem_id,idempotency_key));
  CREATE VIEW artifact_upload_write_authority AS
  SELECT c.credential_id,c.fellow_id,c.sponsor_id,c.issued_at,c.expires_at,c.granted_resources_json,
    s.session_id,s.problem_id,s.opened_at,s.idle_close_at
  FROM fellow_tokens c
  JOIN enrollment_fellows f ON f.fellow_id=c.fellow_id AND f.sponsor_id=c.sponsor_id AND f.status='active'
  JOIN enrollment_grants g ON g.fellow_id=f.fellow_id AND g.sponsor_id=f.sponsor_id
    AND g.granted_scopes_json=c.granted_scopes_json AND g.granted_resources_json=c.granted_resources_json
  JOIN sessions s ON s.fellow_id=f.fellow_id AND s.closed_at IS NULL
  JOIN problem_memberships m ON m.problem_id=s.problem_id AND m.fellow_id=f.fellow_id AND m.role IN ('observer','contributor','steward')
  WHERE c.revoked_at IS NULL AND c.credential_profile='bearer'
    AND EXISTS(SELECT 1 FROM json_each(c.granted_scopes_json) scope WHERE scope.value='upload-artifacts')
    AND NOT EXISTS(SELECT 1 FROM enrollment_sponsor_security sec WHERE sec.sponsor_id=c.sponsor_id AND sec.panic_at>=c.issued_at)
    AND (json_extract(c.granted_resources_json,'$.problemBinding') IS NULL OR json_extract(c.granted_resources_json,'$.problemBinding')=s.problem_id);`);
  sql.exec(readFileSync(new URL("../../../../db/migrations/0070_artifact_publications.sql",import.meta.url),"utf8"));
  let instant = 1_800_000_000_000;
  const clock = () => instant;
  const actor = {
    fellowId:"F-AAAAAAAAAAAAAAAAAAAAAAAAAA",credentialId:"T-ONE",sponsorId:"sponsor-one",name:"Example",
    model:"model",harness:"harness",issuedAt:instant-1000,expiresAt:instant+86_400_000,
    grantedScopes:["promote","upload-artifacts"],grantedResources:{},fellowStatus:"active",
    tokenHash:"0".repeat(64),credentialProfile:"bearer",
  } as FellowCredentialBinding;
  const session = `S-${"A".repeat(26)}`, problem="P-DEMO", upload=`AU-${"a".repeat(32)}`;
  const scopes=JSON.stringify(actor.grantedScopes);
  sql.query("INSERT INTO enrollment_fellows VALUES(?,?,?)").run(actor.fellowId,actor.sponsorId,"active");
  sql.query("INSERT INTO enrollment_grants VALUES(?,?,?,?)").run(actor.fellowId,actor.sponsorId,scopes,"{}");
  sql.query("INSERT INTO fellow_tokens VALUES(?,?,?,?,?,NULL,'bearer',?,?)").run(actor.credentialId,actor.fellowId,actor.sponsorId,actor.issuedAt,actor.expiresAt,scopes,"{}");
  sql.query("INSERT INTO problems VALUES(?,'open',0,1)").run(problem);
  sql.query("INSERT INTO sessions VALUES(?,?,?,?,?,NULL)").run(session,actor.fellowId,problem,new Date(instant-1000).toISOString(),new Date(instant+86_400_000).toISOString());
  sql.query("INSERT INTO problem_memberships VALUES(?,?,'contributor')").run(problem,actor.fellowId);
  const evidenceJson=JSON.stringify({evidence_id:"E-1",kind:"computation",body_md:"Exact reproducible observation"});
  const evidenceDigest=await publicationHash(evidenceJson);
  sql.query("INSERT INTO evidence VALUES(?,?,?)").run(problem,"E-1",actor.fellowId);
  sql.query("INSERT INTO events VALUES(?,?,1,'evidence.created','evidence','E-1',1,?,?,?,?,?,?)")
    .run("EV-1",problem,evidenceDigest,actor.fellowId,actor.sponsorId,session,actor.credentialId,new Date(instant).toISOString());
  sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run("EV-1",evidenceDigest,evidenceJson);
  const bytes=new TextEncoder().encode("theorem example : True := by trivial\n");
  const digest=await artifactSha256(bytes);
  sql.query("INSERT INTO artifact_uploads VALUES(?,?,?,?,'verified',?,?,'text','text/plain; charset=utf-8')")
    .run(upload,actor.fellowId,actor.sponsorId,problem,digest,bytes.length);
  type Statement = D1PreparedStatement & {text:string;values:unknown[]};
  function prepare(text:string,values:unknown[]=[]):Statement {
    return {text,values,
      bind(...items:unknown[]){return prepare(text,items);},
      async first(){return sql.query(text).get(...values as never[]) ?? null;},
      async all(){return {success:true,results:sql.query(text).all(...values as never[]),meta:{changes:0}};},
      async run(){const result=sql.query(text).run(...values as never[]);return {success:true,results:[],meta:{changes:result.changes}};},
    } as unknown as Statement;
  }
  const db={prepare,async batch(statements:readonly Statement[]){
    sql.exec("BEGIN");try{const results=statements.map(s=>{const result=sql.query(s.text).run(...s.values as never[]);return {success:true,results:[],meta:{changes:result.changes}};});sql.exec("COMMIT");return results;}
    catch(e){sql.exec("ROLLBACK");throw e;}
  }} as unknown as D1Database;
  function bucket() {
    const data=new Map<string,{bytes:Uint8Array;httpMetadata:Record<string,string>}>();let writes=0;
    const hooks:{put?:()=>void;get?:()=>void}={};
    const port={async get(key:string){hooks.get?.();const o=data.get(key);if(!o)return null;return {size:o.bytes.length,httpMetadata:o.httpMetadata,
      body:new ReadableStream<Uint8Array>({start(c){c.enqueue(o.bytes.slice());c.close();}})};},
      async put(key:string,value:Uint8Array,options:{httpMetadata:Record<string,string>}){
        hooks.put?.();if(data.has(key))return null;writes++;data.set(key,{bytes:value.slice(),httpMetadata:options.httpMetadata});return {size:value.length};}};
    return {bucket:port as unknown as R2Bucket,data,hooks,writes:()=>writes};
  }
  const privateStore=bucket(),publicStore=bucket();
  privateStore.data.set(`cas/sha256/${digest}`,{bytes,httpMetadata:{}});
  let reservations=0, screens=0;
  const hooks:{beforeWrite?:()=>void}={};
  let writerTail=Promise.resolve();
  const options:PublicationCommandOptions={db,privateBucket:privateStore.bucket,artifactOrigin:"https://artifacts-staging.asimposium.org",clock,
    async readUpload(owner,id){
      const row=sql.query("SELECT * FROM artifact_uploads WHERE upload_id=? AND fellow_id=? AND sponsor_id=?")
        .get(id,owner.fellowId,owner.sponsorId);
      if(!row)throw new Error("NO_MANIFEST");
      return row as Awaited<ReturnType<PublicationCommandOptions["readUpload"]>>;
    },
    async reserve(input){
      const old=sql.query("SELECT * FROM public_write_attempt_reservations WHERE fellow_id=? AND route=? AND idempotency_key=?")
        .get(input.fellowId,input.route,input.idempotencyKey) as {request_digest:string;reservation_id:string}|null;
      if(old){if(old.request_digest!==input.requestDigest)throw new Error("KEY_CONFLICT");return old.reservation_id;}
      reservations++;const id=`Q-${reservations}`;
      sql.query("INSERT INTO public_write_attempt_reservations VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',NULL)")
        .run(id,input.fellowId,input.sponsorId,input.problemId,input.sessionId,input.route,input.idempotencyKey,input.requestDigest,input.now,input.now+60_000);
      return id;
    },
    async writeLedger(input,projection){
      let unlock!:()=>void;const prior=writerTail;writerTail=new Promise<void>(r=>{unlock=r;});await prior;
      try {
        const old=sql.query("SELECT * FROM idempotency WHERE problem_id=? AND idempotency_key=?").get(input.problemId,input.idempotencyKey) as {request_digest:string;event_id:string;event_seq:number}|null;
        if(old){if(old.request_digest!==input.requestDigest)throw new Error("KEY_CONFLICT");return {eventId:old.event_id,seq:old.event_seq};}
        hooks.beforeWrite?.();
        if(!sql.query(`SELECT 1 FROM problems WHERE id=?${projection.preconditionSql??""}`).get(input.problemId,...(projection.preconditionBindings??[]) as never[]))throw new Error("PRECONDITION");
        const seq=(sql.query("SELECT public_seq FROM problems WHERE id=?").get(input.problemId) as {public_seq:number}).public_seq+1;
        const hash=await publicationHash(input.payloadJson);
        const statements=await projection.statementsAfterEvent({sequence:seq,eventId:input.eventId,objectId:input.objectId,payloadSha256:hash});
        await db.batch([
          prepare("UPDATE problems SET public_seq=? WHERE id=?",[seq,input.problemId]),
          prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",[input.eventId,input.problemId,seq,input.eventType,input.objectKind,input.objectId,input.objectVersion,hash,input.attribution.fellowId,input.attribution.sponsorId,input.attribution.sessionId,input.attribution.credentialId,input.createdAt]),
          prepare("INSERT INTO event_content VALUES(?,?,?,NULL)",[input.eventId,hash,input.payloadJson]),
          ...statements,
          prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)",[input.problemId,input.idempotencyKey,input.requestDigest,input.eventId,seq]),
        ]);
        return {eventId:input.eventId,seq};
      } finally {unlock();}
    },
  };
  const drainer:PublicationDrainerOptions={db,privateBucket:privateStore.bucket,publicBucket:publicStore.bucket,
    artifactOrigin:options.artifactOrigin,clock,
    async screen(job,_content){screens++;return {decision:"pass",provider_status:"ok",evaluated_body_digest:`sha256:${job.screening_sha256}`,
      evaluated_context_digest:`sha256:${await publicationScreenContext(job)}`,model_version:"test-model-v1",policy_version:"test-policy-v1",
      configuration_digest:`sha256:${"b".repeat(64)}`,coarse_category:"benign-context"};},
  };
  const input={session_id:session,evidence_id:"E-1",evidence_digest:`sha256:${evidenceDigest}`,publish:true as const,license:"CC-BY-4.0" as const};
  return {sql,db,actor,problem,session,upload,bytes,digest,evidenceDigest,input,options,drainer,privateStore,publicStore,hooks,
    clock,advance:(ms:number)=>{instant+=ms;},reservations:()=>reservations,screens:()=>screens,
    count:(table:string)=>(sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,
  };
}
