import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { readBackupSnapshot } from "../../src/krater/backup-snapshot.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Real SQLite and production snapshot SQL. These identity fixtures are not
 * cryptographic chains; backupProblem retains the canonical chain verifier. */
function fixture(count: number) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,chain_digest TEXT,chain_version INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,payload_sha256 TEXT,created_at TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,
      actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT,writer_credential_id TEXT);
    CREATE TABLE event_chain_v2(event_id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,row_digest TEXT,chain_digest TEXT,chain_version INTEGER);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_json TEXT,payload_sha256 TEXT,redacted_at TEXT);
    CREATE TABLE integrity_checkpoints(problem_id TEXT,checkpoint_seq INTEGER,checkpoint_version INTEGER,checkpoint_mode TEXT,
      PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_chain_v2(problem_id TEXT,checkpoint_seq INTEGER,root_chain_digest TEXT,checkpoint_digest TEXT,chain_version INTEGER,
      PRIMARY KEY(problem_id,checkpoint_seq));
    INSERT INTO problems VALUES('P-DEMO',0,NULL,2);`);
  function append(seq: number) {
    const id = `EV-${seq}`, body = JSON.stringify({ claim_id: `C-${seq}`, statement: `Statement ${seq}` });
    sql.query("INSERT INTO events VALUES(?,'P-DEMO',?,'claim.created','claim',?,1,?,'2026-10-01T00:00:00.000Z','F-author','SP-author',NULL,'declared','harness',NULL)")
      .run(id, seq, `C-${seq}`, hash(body));
    sql.query("INSERT INTO event_chain_v2 VALUES(?,'P-DEMO',?,?,?,2)").run(id, seq, hash(`row-${seq}`), hash(`chain-${seq}`));
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, body, hash(body));
    sql.query("INSERT INTO integrity_checkpoints VALUES('P-DEMO',?,1,'unsigned-v0')").run(seq);
    sql.query("INSERT INTO checkpoint_chain_v2 VALUES('P-DEMO',?,?,?,2)").run(seq, hash(`chain-${seq}`), hash(`pin-${seq}`));
    sql.query("UPDATE problems SET public_seq=?,chain_digest=? WHERE id='P-DEMO'").run(seq, hash(`chain-${seq}`));
  }
  for (let seq = 1; seq <= count; seq++) append(seq);
  const calls: { query: string; values: (string | number | null)[] }[] = [];
  let beforeRead: ((query: string) => void) | undefined;
  const db = { prepare(query: string) { return { bind(...values: (string | number | null)[]) {
    const read = () => {
      beforeRead?.(query);
      calls.push({ query, values });
      return sql.query(query).all(...values);
    };
    return { all: async () => ({ results: read() }), first: async () => read()[0] ?? null };
  } }; } } as unknown as D1Database;
  return { sql, db, append, calls, beforeRead(hook: (query: string) => void) { beforeRead = hook; } };
}

for (const count of [0, 1, 199, 200, 201, 401]) test(`${count} events produce exactly the captured prefix with bounded pages`, async () => {
  const f = fixture(count);
  try {
    const result = await readBackupSnapshot(f.db, "P-DEMO");
    if (count === 0) assert.equal(result, null);
    else {
      assert.equal(result?.events.length, count);
      assert.equal(result?.checkpoints.length, count);
      assert.equal(result?.cursor, count);
      assert.equal(result?.chainDigest, hash(`chain-${count}`));
      assert.deepEqual(result?.events.map((e) => e.seq), Array.from({ length: count }, (_, i) => i + 1));
    }
    assert.equal(f.calls.filter((c) => c.query.includes("FROM events e LEFT")).length, Math.ceil(count / 200));
    assert.ok(f.calls.every((c) => c.query.includes("COUNT(*)") || Number(c.values.at(-1)) <= 200));
  } finally { f.sql.close(); }
});

test("continuous new appends cannot extend a backup beyond its captured head", async () => {
  const f = fixture(201);
  let next = 202;
  try {
    f.beforeRead((query) => { if (query.includes("FROM events e LEFT")) f.append(next++); });
    const result = await readBackupSnapshot(f.db, "P-DEMO");
    assert.equal(result?.cursor, 201);
    assert.equal(result?.events.length, 201);
    assert.equal(result?.chainDigest, hash("chain-201"));
    assert.equal(result?.checkpoints.length, 201);
    assert.equal(next, 204);
    assert.equal((f.sql.query("SELECT public_seq FROM problems").get() as { public_seq: number }).public_seq, 203);
  } finally { f.sql.close(); }
});

test("a checkpoint created for a later append is never attached to the earlier export", async () => {
  const f = fixture(1);
  try {
    f.beforeRead((query) => {
      if (query.includes("FROM integrity_checkpoints")) {
        f.beforeRead(() => {});
        f.append(2);
      }
    });
    const result = await readBackupSnapshot(f.db, "P-DEMO");
    assert.equal(result?.cursor, 1);
    assert.deepEqual(result?.checkpoints.map((c) => c.checkpointSeq), [1]);
  } finally { f.sql.close(); }
});

for (const [name, mutation] of [
  ["missing problem", "DELETE FROM problems"],
  ["negative cursor", "UPDATE problems SET public_seq=-1"],
  ["fractional cursor", "UPDATE problems SET public_seq=1.5"],
  ["missing events", "DELETE FROM events"],
  ["extra unheaded event", "UPDATE problems SET public_seq=0"],
  ["invalid head digest", "UPDATE problems SET chain_digest='invalid'"],
  ["head version", "UPDATE problems SET chain_version=NULL"],
  ["missing sidecar", "DELETE FROM event_chain_v2"],
  ["foreign sidecar", "UPDATE event_chain_v2 SET problem_id='P-OTHER'"],
  ["sidecar sequence", "UPDATE event_chain_v2 SET seq=2"],
  ["sidecar version", "UPDATE event_chain_v2 SET chain_version=1"],
  ["head differs from prefix", `UPDATE event_chain_v2 SET chain_digest='${hash("different")}'`],
  ["missing content", "DELETE FROM event_content"],
  ["null content", "UPDATE event_content SET payload_json=NULL"],
  ["content commitment differs", "UPDATE event_content SET payload_sha256='other'"],
  ["redacted intact bytes", "UPDATE event_content SET redacted_at='2026-10-02T00:00:00.000Z'"],
  ["missing checkpoint sidecar", "DELETE FROM checkpoint_chain_v2"],
  ["checkpoint version", "UPDATE checkpoint_chain_v2 SET chain_version=1"],
  ["checkpoint mode", "UPDATE integrity_checkpoints SET checkpoint_mode='unknown'"],
] as const) test(`${name} is a failed backup, never a fabricated empty success`, async () => {
  const f = fixture(1);
  try {
    f.sql.exec(mutation);
    await assert.rejects(readBackupSnapshot(f.db, "P-DEMO"));
  } finally { f.sql.close(); }
});

test("a disappearing middle event after head capture is refused, not silently truncated", async () => {
  const f = fixture(201);
  try {
    f.beforeRead((query) => {
      if (query.includes("FROM events e LEFT")) {
        f.beforeRead(() => {});
        f.sql.exec("DELETE FROM events WHERE seq=100");
      }
    });
    await assert.rejects(readBackupSnapshot(f.db, "P-DEMO"), /EVENT_IDENTITY_INVALID/);
  } finally { f.sql.close(); }
});

test("sparse checkpoint histories remain valid and do not require one pin per event", async () => {
  const f = fixture(9);
  try {
    f.sql.exec("DELETE FROM integrity_checkpoints WHERE checkpoint_seq NOT IN (2,9)");
    const result = await readBackupSnapshot(f.db, "P-DEMO");
    assert.deepEqual(result?.checkpoints.map((c) => c.checkpointSeq), [2, 9]);
  } finally { f.sql.close(); }
});
