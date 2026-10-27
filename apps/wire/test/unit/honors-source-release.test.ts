import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type HonorsResultRecord,
  type HonorsSourceWitness,
  prepareHonorsSourceCheck,
} from "../../src/discovery/honors-provenance.ts";

// Real SQLite predicates over modeled read tables. The Workerd journey covers
// actual publication, disclosure, correction admission and retained projections.
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE problems(id TEXT,status TEXT,unlisted INTEGER,public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,payload_sha256 TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,object_id TEXT,object_version INTEGER,type TEXT,object_kind TEXT);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,visibility TEXT,version INTEGER);
    CREATE TABLE directive_disclosure_targets(problem_id TEXT,claim_id TEXT,claim_version INTEGER,
      content_digest TEXT,source_event_id TEXT,lineage_json TEXT,scope_requirements_json TEXT,invalidated INTEGER);
    CREATE TABLE directive_disclosure_records(event_id TEXT,problem_id TEXT,claim_id TEXT,claim_version INTEGER,
      seq INTEGER,revision INTEGER,sponsor_id TEXT,scope_id TEXT,coverage_digest TEXT,content_digest TEXT,
      source_event_id TEXT,decision TEXT,public_payload_json TEXT,public_payload_sha256 TEXT);
    INSERT INTO problems VALUES('P-TEST','resolved',0,3);`);
  const insert = (
    id: string,
    seq: number,
    body: string,
    object: string,
    kind: string,
    fellow: string | null,
  ): HonorsSourceWitness => {
    const digest = createHash("sha256").update(body).digest("hex");
    db.query("INSERT INTO events VALUES(?,'P-TEST',?,?,?,?,?,1,?,?)").run(
      id,
      seq,
      digest,
      fellow,
      "usr-owner",
      object,
      kind === "directive-disclosure" ? "directive.disclosure-recorded" : `${kind}.created`,
      kind,
    );
    db.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, digest, body);
    return { event: id, seq, digest, body, fellow, sponsor: "usr-owner" };
  };
  const science = insert("E-science", 1, '{"claim_id":"C-1"}', "C-1", "claim", "F-author");
  const context = insert("E-context", 2, '{"claim_id":"C-2"}', "C-2", "claim", "F-other");
  const disclosure = insert(
    "E-disclosure",
    3,
    '{"decision":"no-undisclosed"}',
    "E-disclosure",
    "directive-disclosure",
    null,
  );
  db.query(`INSERT INTO directive_disclosure_targets VALUES('P-TEST','C-1',1,'content','E-science',
    '{"pins":[]}','[{"scope_id":"scope","coverage_digest":"coverage"}]',0)`).run();
  db.query(`INSERT INTO directive_disclosure_records VALUES('E-disclosure','P-TEST','C-1',1,
    3,1,'usr-owner','scope','coverage','content','E-science','no-undisclosed',?,?)`).run(
    disclosure.body,
    disclosure.digest,
  );
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...args: (string | number | null)[]) {
          return {
            async all() {
              return { results: db.query(sql).all(...args) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const record: HonorsResultRecord = {
    item: {
      kind: "claim",
      result_id: "C-1",
      problem_id: "P-TEST",
      settled_at: "2026-10-27T00:00:00.000Z",
      sequence: 3,
      status: "strongly-supported",
      title: "Exact result",
      contributing_fellows: [],
      carrying_reviewers: [],
      dag_context: { depends_on: [], unlocks: ["C-2@1"], closes_gaps: [] },
      evidence_trail: [],
    },
    scope: { problem: "P-TEST", through: 3, claim: "C-1", version: 1 },
    witnesses: [science, disclosure],
    contextWitnesses: [context],
  };
  const available = async () =>
    (await prepareHonorsSourceCheck(d1, record).all<{ available: number }>()).results[0]?.available;
  return { db, d1, record, available };
}

test("the final release check accepts matching science, disclosure and DAG witnesses", async () => {
  const f = fixture();
  expect(await f.available()).toBe(1);
});
for (const [label, change] of [
  ["later science event", "UPDATE problems SET public_seq=4"],
  ["unlisted problem", "UPDATE problems SET unlisted=1"],
  ["private problem", "UPDATE problems SET status='private-draft'"],
  [
    "redacted carrying source",
    "UPDATE event_content SET redacted_at='now' WHERE event_id='E-science'",
  ],
  [
    "substituted bytes under the old digest",
    "UPDATE event_content SET payload_json='{}' WHERE event_id='E-science'",
  ],
  [
    "changed historical actor",
    "UPDATE events SET actor_sponsor_id='usr-other' WHERE id='E-science'",
  ],
  [
    "hidden exact science version",
    "INSERT INTO content_controls VALUES('P-TEST','C-1@1','hidden',1)",
  ],
  ["hidden downstream context", "INSERT INTO content_controls VALUES('P-TEST','C-2','hidden',1)"],
  [
    "hidden context publication event",
    "INSERT INTO content_controls VALUES('P-TEST','#2','hidden',1)",
  ],
  [
    "hidden sponsor disclosure",
    "INSERT INTO content_controls VALUES('P-TEST','E-disclosure','hidden',1)",
  ],
  ["withdrawn disclosure", "UPDATE directive_disclosure_records SET decision='withdraw'"],
] as const) {
  test(`an intervening ${label} fails the final release check`, async () => {
    const f = fixture();
    expect(await f.available()).toBe(1);
    f.db.exec(change);
    expect(await f.available()).toBe(0);
  });
}
test("conflicting retained source pins and oversized documents fail closed before D1", () => {
  const f = fixture();
  const original = f.record.witnesses[0];
  if (!original) throw new Error("Missing source witness in fixture");
  f.record.contextWitnesses.push({ ...original, body: "changed" });
  expect(() => prepareHonorsSourceCheck(f.d1, f.record)).toThrow("witnesses disagree");
  f.record.contextWitnesses.splice(1);
  f.record.contextWitnesses.push({
    event: "oversized",
    seq: 2,
    digest: "0".repeat(64),
    body: "x".repeat(1024 * 1024),
    fellow: null,
    sponsor: null,
  });
  expect(() => prepareHonorsSourceCheck(f.d1, f.record)).toThrow("read budget");
});
