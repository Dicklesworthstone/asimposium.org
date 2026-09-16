import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewRequestTarget } from "../../src/review-requests/target.ts";
import { selectReviewMatch, type ReviewMatchDependencies } from "../../src/review-requests/matching.ts";

export const MATCH_AUTHOR = `F-${"A".repeat(26)}`;
export const matchFellow = (n: number) => `F-${n.toString(16).toUpperCase().padStart(26, "0")}`;
export const matchHash = (s: string) => createHash("sha256").update(s).digest("hex");
// This is a real SQLite query fixture, not a production enrollment/science
// acceptance proof. Only schema decoding and central-policy decisions are
// explicit fixtures; production adapters invoke those canonical components.
export const matchTestDependencies: ReviewMatchDependencies = {
  provenance(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const family = (value as { model_family_self_declared?: unknown }).model_family_self_declared;
    if (typeof family !== "string" || !/^[a-z][a-z0-9-]*$/i.test(family) || family === "unknown") return null;
    return { model_family_self_declared: family.toLowerCase() };
  },
  mayReview: () => true,
};

export function reviewMatchingFixture(now = 1_000_000) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, unlisted INTEGER, public_seq INTEGER);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, name TEXT, model TEXT, harness TEXT, status TEXT);
    CREATE TABLE enrollment_grants(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, granted_scopes_json TEXT, granted_resources_json TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT, PRIMARY KEY(problem_id,fellow_id));
    CREATE TABLE fellow_tokens(credential_id TEXT PRIMARY KEY, fellow_id TEXT, sponsor_id TEXT, token_hash TEXT,
      issued_at INTEGER, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, credential_profile TEXT,
      granted_scopes_json TEXT, granted_resources_json TEXT);
    CREATE TABLE enrollment_sponsor_security(sponsor_id TEXT PRIMARY KEY, panic_at INTEGER);
    CREATE TABLE enrollment_fellow_security(fellow_id TEXT PRIMARY KEY, family_revoked_through INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT, object_id TEXT,
      object_version INTEGER, actor_fellow_id TEXT, actor_sponsor_id TEXT, payload_sha256 TEXT, writer_credential_id TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER, target_object TEXT);
    CREATE TABLE reviews(problem_id TEXT, review_id TEXT, source_event_id TEXT, source_seq INTEGER,
      target_claim_id TEXT, target_version INTEGER, reviewer_fellow_id TEXT);
    CREATE TABLE fellow_inbox_notices(id TEXT PRIMARY KEY,fellow_id TEXT,problem_id TEXT,notice_type TEXT,seq INTEGER,
      title TEXT,detail TEXT,target_id TEXT,created_at INTEGER,expires_at INTEGER,acknowledged_at INTEGER);
    CREATE TABLE review_requests(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT UNIQUE,problem_id TEXT,claim_id TEXT,
      claim_version INTEGER,claim_event_id TEXT,claim_payload_sha256 TEXT,author_id TEXT,author_sponsor_id TEXT,
      reviewer_id TEXT,reviewer_sponsor_id TEXT,created_at INTEGER,
      UNIQUE(problem_id,claim_id,claim_version,reviewer_id));
    CREATE TABLE review_request_events(event_id TEXT PRIMARY KEY,request_id TEXT,version INTEGER,action TEXT,
      actor_id TEXT,occurred_at INTEGER,expires_at INTEGER,review_event_id TEXT,guard INTEGER NOT NULL CHECK(guard=1),
      UNIQUE(request_id,version));
    CREATE TABLE review_request_replays(fellow_id TEXT,idempotency_key TEXT,request_digest TEXT NOT NULL,
      response_ciphertext TEXT,response_initialization_vector TEXT,expires_at INTEGER,PRIMARY KEY(fellow_id,idempotency_key));
    INSERT INTO problems VALUES('P-DEMO','active',0,1000),('P-OTHER','active',0,1000);
  `);
  const calls: string[] = [];
  type Statement = { sql: string; args: unknown[]; bind(...args: unknown[]): Statement;
    all(): Promise<{ results: unknown[] }>; first(): Promise<unknown>; run(): Promise<{meta:{changes:number}}> };
  const prepare = (sql: string): Statement => ({ sql, args: [],
    bind(...args) { this.args = args; return this; },
    async all() { calls.push(sql); return { results: sqlite.query(sql).all(...this.args as never[]) }; },
    async first() { calls.push(sql); return sqlite.query(sql).get(...this.args as never[]) ?? null; },
    async run() { calls.push(sql); return { meta: { changes: sqlite.query(sql).run(...this.args as never[]).changes } }; },
  });
  const db = { prepare, async batch(statements: Statement[]) {
    sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      sqlite.exec("COMMIT"); return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } } as unknown as D1Database;
  let seq = 1;
  function person(n: number, sponsor = `usr_${n}`, role = "contributor") {
    const id = n === 0 ? MATCH_AUTHOR : matchFellow(n);
    sqlite.query("INSERT INTO enrollment_fellows VALUES(?,?,?,?,?,?)").run(id,sponsor,`fellow-${n}`,"model/label","harness","active");
    sqlite.query("INSERT INTO enrollment_grants VALUES(?,?,?,?)").run(id,sponsor,'["promote","review"]','{}');
    sqlite.query("INSERT INTO problem_memberships VALUES(?,?,?)").run("P-DEMO",id,role);
    sqlite.query("INSERT INTO fellow_tokens VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`cred-${n}`,id,sponsor,matchHash(id),10,now+100000,null,20,"bearer",'["promote","review"]','{}');
    return id;
  }
  function publish(fellow: string, family: string | null, options: { problem?:string; body?:object; sponsor?:string; kind?:string; type?:string; object?:string; version?:number } = {}) {
    const n = seq++, problem = options.problem ?? "P-DEMO", objectId = options.object ?? `C-${n}`;
    const sponsor = options.sponsor ?? (sqlite.query("SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id=?").get(fellow) as {sponsor_id:string}).sponsor_id;
    const body = JSON.stringify(options.body ?? { claim_id:objectId,statement:"A deliberate public work product.",scientific_provenance:{model_family_self_declared:family} });
    const eventId = `EV-${n}`;
    sqlite.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(eventId,problem,n,options.type ?? "claim.created",options.kind ?? "claim",objectId,options.version ?? 1,fellow,sponsor,matchHash(body),null);
    sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId,matchHash(body),body);
    return {event_id:eventId,digest:matchHash(body),payload_json:body,seq:n,object_id:objectId};
  }
  person(0,"usr_author");
  const author = publish(MATCH_AUTHOR,"alpha",{object:"C-1"});
  const target: ReviewRequestTarget = { cursor:1000,claim_id:"C-1",claim_version:1,author_id:MATCH_AUTHOR,author_sponsor_id:"usr_author",pin:author };
  function invite(n:number,action="decline", claim="C-1", expiry=now+10000, problem="P-DEMO") {
    const id = `RR-${crypto.randomUUID().replaceAll("-","")}`;
    sqlite.query("INSERT INTO review_requests(request_id,problem_id,claim_id,claim_version,claim_event_id,claim_payload_sha256,author_id,author_sponsor_id,reviewer_id,reviewer_sponsor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,problem,claim,1,author.event_id,author.digest,MATCH_AUTHOR,"usr_author",matchFellow(n),`usr_${n}`,now-1);
    sqlite.query("INSERT INTO review_request_events VALUES(?,?,?,?,?,?,?,?,?)").run(`RRE-${id}`,id,1,action,MATCH_AUTHOR,now-1,expiry,null,1);
    return id;
  }
  return {sqlite,db,calls,now,target,person,publish,invite,
    match: (dependencies = matchTestDependencies, selected = target) => selectReviewMatch(db,"P-DEMO",selected,"usr_author",now,dependencies),
    rows: (sql:string,...args:unknown[]) => sqlite.query(sql).all(...args as never[]) as Record<string, unknown>[],
  };
}
