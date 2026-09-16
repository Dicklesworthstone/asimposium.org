import { test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { readReviewQueue, verifiedReviewMetadata, type ReviewAdmission, type ReviewMetadata, type ReviewQueueScience } from "../../src/discovery/review-queue-read";
import { REVIEW_QUEUE_DISCOVERY_SQL, REVIEW_QUEUE_METADATA_SQL } from "../../src/discovery/review-queue-sql";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const instant = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 1000).toISOString();
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_kind TEXT,
      type TEXT, object_id TEXT, object_version INTEGER, created_at TEXT, actor_fellow_id TEXT,
      actor_sponsor_id TEXT, payload_sha256 TEXT, UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE claim_versions(problem_id TEXT, claim_id TEXT, version INTEGER, kind TEXT, statement TEXT,
      falsifier TEXT, content_digest TEXT, PRIMARY KEY(problem_id,claim_id,version));
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER, target_object TEXT);`);
  const bindings = new Map<object, { sql: string; values: (string | number | null)[] }>();
  const db = {
    prepare(statement: string) {
      const make = (values: (string | number | null)[]) => {
        const prepared = {
          bind: (...args: (string | number | null)[]) => make(args),
          all: async () => ({ results: sql.prepare(statement).all(...values) }),
        };
        bindings.set(prepared, { sql: statement, values });
        return prepared;
      };
      return make([]);
    },
    async batch(statements: object[]) {
      sql.exec("BEGIN");
      try {
        const result = statements.map(statement => {
          const bound = bindings.get(statement);
          if (!bound) throw new Error("unknown prepared statement");
          return { results: sql.prepare(bound.sql).all(...bound.values) };
        });
        sql.exec("COMMIT"); return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  function problem(id = "P-MATH", status = "active", unlisted = 0) {
    sql.prepare("INSERT INTO problems VALUES (?, 1000, ?, ?)").run(id, status, unlisted);
  }
  function claim(id: string, seq: number, opts: {
    problem?: string; version?: number; statement?: string; sponsor?: string;
    pins?: unknown[]; falsifier?: string | null;
  } = {}) {
    const p = opts.problem ?? "P-MATH", version = opts.version ?? 1;
    const event = `EV-${p}-${id}-${version}`;
    const statement = opts.statement ?? `Every admissible input for ${id} obeys the stated bound.`;
    const falsifier = opts.falsifier === undefined ? "An admissible input exceeding the bound." : opts.falsifier;
    const payload = JSON.stringify({ claim_id: id, statement,
      ...(version > 1 ? { base_version: version - 1 } : {}), dependency_pins: opts.pins ?? [] });
    const payloadDigest = sha(payload);
    const contentDigest = `sha256:${sha(JSON.stringify({ falsifier, kind: "conjecture", statement }))}`;
    sql.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(event,p,seq,"claim",
      version === 1 ? "claim.created" : "claim.revised",id,version,instant(seq),"F-AUTHOR",opts.sponsor ?? "SP-A",payloadDigest);
    sql.prepare("INSERT INTO event_content VALUES (?,?,?,NULL)").run(event,payloadDigest,payload);
    sql.prepare("INSERT INTO claim_versions VALUES (?,?,?,?,?,?,?)").run(p,id,version,"conjecture",statement,falsifier,contentDigest);
    return { claim_id:id, version, event_id:event, payload_digest:payloadDigest, content_digest:contentDigest };
  }
  // This fixture tests SQL and queue composition, NOT the scientific evaluator.
  // The production service injects the real prepareScientificDispositions/foldScientificRows.
  const science: ReviewQueueScience = {
    prepare: (db, _p, _c, _n, target) => db.prepare("SELECT ? AS target_version").bind(target.version),
    fold: async rows => ({ disposition:"open",currentVersion:rows[0]?.target_version ?? null,
      stale:false,legacyReviews:0,context:{recorded_refutation_attempts:0,verified_reviews:[],has_certified_artifact:false} }),
  };
  const discover = () => sql.prepare(REVIEW_QUEUE_DISCOVERY_SQL).all(null,null,"","","",9) as ReviewAdmission[];
  const metadata = (a: ReviewAdmission) => sql.prepare(REVIEW_QUEUE_METADATA_SQL)
    .get(a.cursor,a.cursor,a.cursor,a.head_id,a.problem_id,a.cursor) as ReviewMetadata | null | undefined;
  return { sql, db, problem, claim, science, discover, metadata };
}

test("real SQLite: queue composes source-verified statements and exact links", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1);
    const response=await readReviewQueue(f.db,{},f.science);
    assert.equal(response.candidates.length,1);
    assert.equal(response.candidates[0]?.read_url,"/p/P-MATH/claims/C-1@1.md?through=1000");
    assert.equal(response.candidates[0]?.need,"independent-review");
    assert.equal(response.scanned,1); assert.equal(response.next_after,null);
  } finally { f.sql.close(); }
});
for (const mode of ["private", "unlisted", "resolved", "unpublished"] as const) {
  test(`real SQLite: ${mode} work is absent from discovery`, async () => {
    const f=fixture(); try {
      f.problem("P-HIDDEN",mode === "private" ? "private-draft" : mode === "resolved" ? "resolved" : "active",mode === "unlisted" ? 1:0);
      f.claim("C-1",1,{problem:"P-HIDDEN"});
      if (mode === "unpublished") f.sql.exec("UPDATE problems SET public_seq=0");
      const result=await readReviewQueue(f.db,{},f.science);
      assert.equal(result.candidates.length,0); assert.equal(result.scanned,0);
      assert.equal(JSON.stringify(result).includes("P-HIDDEN"),false);
    } finally { f.sql.close(); }
  });
}
test("real SQLite: identical claim IDs remain problem scoped", async () => {
  const f=fixture(); try {
    f.problem("P-ONE"); f.problem("P-TWO");
    f.claim("C-1",1,{problem:"P-ONE",statement:"First problem unique statement."});
    f.claim("C-1",1,{problem:"P-TWO",statement:"Second problem distinct statement."});
    const result=await readReviewQueue(f.db,{problem:"P-TWO"},f.science);
    assert.equal(result.candidates.length,1);
    assert.equal(result.candidates[0]?.statement,"Second problem distinct statement.");
    assert.equal(result.candidates[0]?.problem_id,"P-TWO");
  } finally { f.sql.close(); }
});
test("real SQLite: published revision supplies new bytes but keeps original authorship", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1,{sponsor:"SP-ORIGINAL"});
    f.claim("C-1",4,{version:2,sponsor:"SP-EDITOR",statement:"A revised exact statement."});
    const result=await readReviewQueue(f.db,{},f.science);
    assert.equal(result.candidates[0]?.version,2);
    assert.equal(result.candidates[0]?.statement,"A revised exact statement.");
    assert.equal(result.candidates[0]?.author_sponsor_id,"SP-ORIGINAL");
    assert.equal(result.candidates[0]?.created_at,instant(1));
  } finally { f.sql.close(); }
});
test("real SQLite: later unpublished revision cannot displace the public head", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1); f.claim("C-1",4,{version:2,statement:"Not yet public."});
    f.sql.exec("UPDATE problems SET public_seq=2");
    const result=await readReviewQueue(f.db,{},f.science);
    assert.equal(result.candidates[0]?.version,1);
    assert.equal(JSON.stringify(result).includes("Not yet public."),false);
  } finally { f.sql.close(); }
});
for (const change of ["redact-head", "redact-author", "tamper-body", "tamper-falsifier", "tamper-kind", "detach-digest"] as const) {
  test(`real SQLite: ${change} is excluded without publishing retained bytes`, async () => {
    const f=fixture(); try {
      f.problem(); f.claim("C-1",1); const head=f.claim("C-1",4,{version:2,statement:"CANARY unavailable scientific text"});
      if(change === "redact-head") f.sql.prepare("UPDATE event_content SET redacted_at='removed' WHERE event_id=?").run(head.event_id);
      if(change === "redact-author") f.sql.prepare("UPDATE event_content SET redacted_at='removed' WHERE event_id<>?").run(head.event_id);
      if(change === "tamper-body") f.sql.prepare("UPDATE event_content SET payload_json=payload_json || ' ' WHERE event_id=?").run(head.event_id);
      if(change === "tamper-falsifier") f.sql.exec("UPDATE claim_versions SET falsifier='Different falsifier'");
      if(change === "tamper-kind") f.sql.exec("UPDATE claim_versions SET kind='different-kind'");
      if(change === "detach-digest") f.sql.exec("UPDATE event_content SET payload_sha256='invalid'");
      const result=await readReviewQueue(f.db,{},f.science);
      assert.equal(result.candidates.length,0);
      assert.equal(result.omitted[0]?.reason,"content_unavailable");
      assert.equal(JSON.stringify(result).includes("CANARY"),false);
    } finally { f.sql.close(); }
  });
}
test("real SQLite: current privacy wins between discovery and the content snapshot", () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1); const row=f.discover()[0]; assert.ok(row);
    f.sql.exec("UPDATE problems SET unlisted=1");
    const hidden = f.metadata(row);
    assert.ok(hidden === undefined || hidden === null);
  } finally { f.sql.close(); }
});
test("real SQLite: old captured head survives a concurrent revision", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1); f.sql.exec("UPDATE problems SET public_seq=1");
    const row=f.discover()[0]; assert.ok(row);
    f.claim("C-1",4,{version:2}); f.sql.exec("UPDATE problems SET public_seq=4");
    const old=f.metadata(row); assert.ok(old);
    assert.equal(old.version,1); assert.equal(await verifiedReviewMetadata(row,old),true);
  } finally { f.sql.close(); }
});
test("real SQLite: a fully excluded page still advances past the scanned prefix", async () => {
  const f=fixture(); try {
    f.problem(); for(let i=1;i<=10;i+=1) f.claim(`C-${i}`,i);
    f.sql.exec("UPDATE event_content SET redacted_at='removed'");
    const first=await readReviewQueue(f.db,{},f.science);
    assert.equal(first.scanned,8); assert.equal(first.candidates.length,0); assert.ok(first.next_after);
    const second=await readReviewQueue(f.db,{after:first.next_after},f.science);
    assert.equal(second.scanned,2); assert.equal(second.next_after,null);
  } finally { f.sql.close(); }
});
test("real SQLite: only exact, available, committed dependency pins affect ranking", async () => {
  const f=fixture(); try {
    f.problem(); const premise=f.claim("C-1",1); f.claim("C-2",2);
    f.claim("C-3",3,{pins:[premise]});
    f.claim("C-4",4,{pins:[{...premise,version:2}]});
    const hidden=f.claim("C-5",5,{pins:[premise]});
    f.sql.prepare("UPDATE event_content SET redacted_at='removed' WHERE event_id=?").run(hidden.event_id);
    const result=await readReviewQueue(f.db,{},f.science);
    assert.equal(result.candidates[0]?.claim_id,"C-1");
    assert.equal(result.candidates[0]?.direct_dependents,1);
    assert.equal(result.candidates.find(x=>x.claim_id==="C-2")?.direct_dependents,0);
  } finally { f.sql.close(); }
});
test("real SQLite: old dependent versions and malformed pins do not invent consequence", async () => {
  const f=fixture(); try {
    f.problem(); const premise=f.claim("C-1",1);
    f.claim("C-2",2,{pins:[premise]}); f.claim("C-2",3,{version:2,pins:[]});
    f.claim("C-3",4,{pins:["not-json",null,42,{claim_id:"C-1"}]});
    const result=await readReviewQueue(f.db,{},f.science);
    assert.equal(result.candidates.find(x=>x.claim_id==="C-1")?.direct_dependents,0);
  } finally { f.sql.close(); }
});
test("real SQLite: oversized histories are omitted before scientific replay starts", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1);
    f.sql.prepare("UPDATE event_content SET payload_json=?").run("x".repeat(1024*1024+1));
    let replayed=0;
    const result=await readReviewQueue(f.db,{}, { ...f.science, prepare(...args) { replayed+=1;return f.science.prepare(...args); } });
    assert.equal(replayed,0); assert.equal(result.candidates.length,0);
    assert.equal(result.omitted[0]?.reason,"scope_budget_exceeded");
  } finally { f.sql.close(); }
});
test("real SQLite: missing falsifier is not presented as a ready conjecture", async () => {
  const f=fixture(); try {
    f.problem(); f.claim("C-1",1,{falsifier:null});
    const result=await readReviewQueue(f.db,{},f.science);
    assert.equal(result.candidates.length,0); assert.equal(result.omitted[0]?.reason,"not_review_ready");
  } finally { f.sql.close(); }
});
