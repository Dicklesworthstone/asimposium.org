import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createRestoreFence } from "../../src/krater/restore-fence.ts";

type Source = Parameters<typeof createRestoreFence>[1];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Real SQLite and production fence SQL. The minimal schema models only the
 * recovery boundary; this is not a migration/Workerd/cryptographic-verifier test.
 * source is the explicit output fixture of the upstream verified-export parser. */
function fixture(count = 1) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, chain_digest TEXT,
      chain_version INTEGER, title TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      created_at TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_chain_v2(event_id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER,
      row_digest TEXT, chain_digest TEXT, chain_version INTEGER, UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE integrity_checkpoints(problem_id TEXT, checkpoint_seq INTEGER,
      root_chain_digest TEXT, checkpoint_digest TEXT, checkpoint_version INTEGER,
      checkpoint_mode TEXT, PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_chain_v2(problem_id TEXT, checkpoint_seq INTEGER,
      root_chain_digest TEXT, checkpoint_digest TEXT, chain_version INTEGER,
      PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE krater_integrity_backfill(problem_id TEXT PRIMARY KEY,state TEXT,chain_version INTEGER);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,visibility TEXT);
    CREATE TABLE rebuilt(id TEXT PRIMARY KEY, body TEXT);
  `);
  const events = Array.from({ length: count }, (_, offset) => {
    const seq = offset + 1;
    const payloadJson = JSON.stringify({ statement: `Claim ${seq}`, claim_id: `C-${seq}` });
    return {
      eventId: `EV-${seq}`, seq, type: "claim.created", objectKind: "claim", objectId: `C-${seq}`,
      objectVersion: 1, payloadJson, payloadSha256: hash(payloadJson), rowDigest: hash(`row-${seq}`),
      chainDigest: hash(`chain-${seq}`), createdAt: "2026-10-01T00:00:00.000Z",
      actorFellowId: "F-author", actorSponsorId: "SP-author", actorSessionId: null,
      modelStringSelfDeclared: "declared", harness: "harness", writerCredentialId: null,
    };
  });
  const checkpoints = events.map((event) => ({ checkpointSeq: event.seq,
    rootChainDigest: event.chainDigest, checkpointDigest: hash(`pin-${event.seq}`) }));
  const source: Source = { ok: true, header: { problem: "P-DEMO", checkpoints }, events,
    trailer: { problem: "P-DEMO", eventCount: count, finalCursor: count } };
  sql.query("INSERT INTO problems VALUES('P-DEMO',?,?,2,'scratch')")
    .run(count, events.at(-1)?.chainDigest ?? hash("genesis"));
  sql.exec("INSERT INTO krater_integrity_backfill VALUES('P-DEMO','complete',2)");
  for (const event of events) {
    sql.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      event.eventId, "P-DEMO", event.seq, event.type, event.objectKind, event.objectId,
      event.objectVersion, event.payloadSha256, event.createdAt, event.actorFellowId,
      event.actorSponsorId, event.actorSessionId, event.modelStringSelfDeclared,
      event.harness, event.writerCredentialId,
    );
    sql.query("INSERT INTO event_chain_v2 VALUES(?,'P-DEMO',?,?,?,2)")
      .run(event.eventId, event.seq, event.rowDigest, event.chainDigest);
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)")
      .run(event.eventId, event.payloadSha256, event.payloadJson);
  }
  for (const pin of checkpoints) {
    sql.query("INSERT INTO integrity_checkpoints VALUES('P-DEMO',?,?,?,1,'unsigned-v0')")
      .run(pin.checkpointSeq, pin.rootChainDigest, pin.checkpointDigest);
    sql.query("INSERT INTO checkpoint_chain_v2 VALUES('P-DEMO',?,?,?,2)")
      .run(pin.checkpointSeq, pin.rootChainDigest, pin.checkpointDigest);
  }
  const raw = new WeakMap<object, { query: string; values: (string | number | null)[] }>();
  let beforeBatch: (() => void) | undefined;
  const queries: string[] = [];
  function prepare(query: string, values: (string | number | null)[] = []): D1PreparedStatement {
    const statement = { bind: (...args: (string | number | null)[]) => prepare(query, args) };
    raw.set(statement, { query, values });
    return statement as D1PreparedStatement;
  }
  const db = { prepare, async batch(statements: D1PreparedStatement[]) {
    const hook = beforeBatch;
    beforeBatch = undefined;
    hook?.();
    sql.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const input = raw.get(statement);
        assert.ok(input);
        queries.push(input.query);
        const results = sql.query(input.query).all(...input.values);
        return { success: true, results, meta: { changes: 0 } };
      });
      sql.exec("COMMIT");
      return results;
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  } } as unknown as D1Database;
  return { sql, source, db, queries, fence: createRestoreFence(db, source),
    beforeBatch(hook: () => void) { beforeBatch = hook; } };
}

for (const count of [1, 8, 9, 17]) test(`exact ${count}-event restores are resumable across bounded guard pages`, async () => {
  const f = fixture(count);
  try {
    assert.equal(await f.fence.matches(), true);
    await f.fence.database.prepare("INSERT INTO rebuilt VALUES(?,?)").bind("claim", "body").run();
    const row = await f.fence.database.prepare("SELECT * FROM rebuilt WHERE id = ?").bind("claim").first();
    assert.deepEqual(row, { id: "claim", body: "body" });
    assert.equal(await f.fence.matches(), true);
    const results = await f.fence.database.batch([
      f.fence.database.prepare("SELECT id FROM rebuilt"),
      f.fence.database.prepare("SELECT public_seq FROM problems"),
    ]);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0]!.results, [{ id: "claim" }]);
    assert.deepEqual(results[1]!.results, [{ public_seq: count }]);
    assert.ok(f.queries.some((q) => q.includes("abs(-9223372036854775808)")));
  } finally { f.sql.close(); }
});

const damage = [
  ["head sequence", "UPDATE problems SET public_seq=0"],
  ["head root", "UPDATE problems SET chain_digest='other'"],
  ["head version", "UPDATE problems SET chain_version=NULL"],
  ["missing problem", "DELETE FROM problems"],
  ["missing envelope", "DELETE FROM events"],
  ["event id", "UPDATE events SET id='EV-OTHER'"],
  ["event scope", "UPDATE events SET problem_id='P-OTHER'"],
  ["event sequence", "UPDATE events SET seq=2"],
  ["event type", "UPDATE events SET type='claim.revised'"],
  ["event kind", "UPDATE events SET object_kind='hypothesis'"],
  ["object id", "UPDATE events SET object_id='C-2'"],
  ["object version", "UPDATE events SET object_version=2"],
  ["payload commitment", "UPDATE events SET payload_sha256='other'"],
  ["event time", "UPDATE events SET created_at='2026-10-02T00:00:00.000Z'"],
  ["author", "UPDATE events SET actor_fellow_id='F-other'"],
  ["sponsor", "UPDATE events SET actor_sponsor_id='SP-other'"],
  ["session", "UPDATE events SET actor_session_id='SS-other'"],
  ["model", "UPDATE events SET model_string_self_declared='other'"],
  ["harness", "UPDATE events SET harness='other'"],
  ["credential", "UPDATE events SET writer_credential_id='FC-other'"],
  ["missing sidecar", "DELETE FROM event_chain_v2"],
  ["sidecar scope", "UPDATE event_chain_v2 SET problem_id='P-OTHER'"],
  ["sidecar sequence", "UPDATE event_chain_v2 SET seq=2"],
  ["sidecar row", "UPDATE event_chain_v2 SET row_digest='other'"],
  ["sidecar root", "UPDATE event_chain_v2 SET chain_digest='other'"],
  ["sidecar version", "UPDATE event_chain_v2 SET chain_version=1"],
  ["payload bytes", "UPDATE event_content SET payload_json='{}'"],
  ["payload digest", "UPDATE event_content SET payload_sha256='other'"],
  ["redaction", "UPDATE event_content SET redacted_at='2026-10-02T00:00:00.000Z'"],
  ["missing payload", "DELETE FROM event_content"],
  ["missing checkpoint", "DELETE FROM integrity_checkpoints"],
  ["checkpoint root", "UPDATE integrity_checkpoints SET root_chain_digest='other'"],
  ["checkpoint digest", "UPDATE integrity_checkpoints SET checkpoint_digest='other'"],
  ["checkpoint version", "UPDATE integrity_checkpoints SET checkpoint_version=2"],
  ["checkpoint mode", "UPDATE integrity_checkpoints SET checkpoint_mode='unknown'"],
  ["missing checkpoint sidecar", "DELETE FROM checkpoint_chain_v2"],
  ["checkpoint sidecar digest", "UPDATE checkpoint_chain_v2 SET checkpoint_digest='other'"],
  ["checkpoint sidecar root", "UPDATE checkpoint_chain_v2 SET root_chain_digest='other'"],
  ["checkpoint sidecar version", "UPDATE checkpoint_chain_v2 SET chain_version=1"],
  ["incomplete backfill", "UPDATE krater_integrity_backfill SET state='required'"],
  ["backfill version", "UPDATE krater_integrity_backfill SET chain_version=NULL"],
  ["missing backfill", "DELETE FROM krater_integrity_backfill"],
  ["hidden problem", "INSERT INTO content_controls VALUES('P-DEMO','problem','hidden')"],
  ["hidden object", "INSERT INTO content_controls VALUES('P-DEMO','C-1','hidden')"],
  ["existing control history", "INSERT INTO content_controls VALUES('P-DEMO','C-1','visible')"],
  ["extra checkpoint", "INSERT INTO integrity_checkpoints VALUES('P-DEMO',2,'other','other',1,'unsigned-v0')"],
  ["extra sidecar", "INSERT INTO event_chain_v2 VALUES('EV-EXTRA','P-DEMO',2,'other','other',2)"],
] as const;
for (const [name, mutation] of damage) test(`${name} refuses resumption and rolls back projection writes`, async () => {
  const f = fixture();
  try {
    assert.equal(await f.fence.matches(), true);
    f.sql.exec(mutation);
    assert.equal(await f.fence.matches(), false);
    await assert.rejects(f.fence.database.prepare("INSERT INTO rebuilt VALUES('claim','resurrected')").run());
    assert.equal((f.sql.query("SELECT COUNT(*) AS n FROM rebuilt").get() as { n: number }).n, 0);
  } finally { f.sql.close(); }
});

test("a changed target between probe and write cannot overwrite the governance head", async () => {
  const f = fixture();
  try {
    assert.equal(await f.fence.matches(), true);
    f.beforeBatch(() => f.sql.exec("UPDATE problems SET public_seq=2, title='newer'"));
    await assert.rejects(f.fence.database.prepare("UPDATE problems SET title='stale' WHERE id='P-DEMO'").run());
    assert.equal((f.sql.query("SELECT title FROM problems").get() as { title: string }).title, "newer");
  } finally { f.sql.close(); }
});

test("a redaction arriving after replay's read prevents every write in its batch", async () => {
  const f = fixture();
  try {
    await f.fence.database.prepare("SELECT payload_json FROM event_content").all();
    f.beforeBatch(() => f.sql.exec("UPDATE event_content SET redacted_at='redacted'"));
    await assert.rejects(f.fence.database.batch([
      f.fence.database.prepare("INSERT INTO rebuilt VALUES('first','old body')"),
      f.fence.database.prepare("INSERT INTO rebuilt VALUES('second','old body')"),
    ]));
    assert.deepEqual(f.sql.query("SELECT * FROM rebuilt").all(), []);
  } finally { f.sql.close(); }
});

test("a later statement failure rolls back earlier projection inserts", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.fence.database.batch([
      f.fence.database.prepare("INSERT INTO rebuilt VALUES('same','first')"),
      f.fence.database.prepare("INSERT INTO rebuilt VALUES('same','second')"),
    ]));
    assert.deepEqual(f.sql.query("SELECT * FROM rebuilt").all(), []);
    assert.equal(await f.fence.matches(), true);
  } finally { f.sql.close(); }
});

test("first, named-column reads, rebinding and statement ownership preserve the D1 boundary", async () => {
  const f = fixture();
  try {
    const query = f.fence.database.prepare("SELECT id FROM problems WHERE id = ?");
    assert.equal(await query.bind("absent").first(), null);
    assert.equal(await query.bind("P-DEMO").first("id"), "P-DEMO");
    await assert.rejects(query.bind("P-DEMO").first("missing"), /COLUMN_INVALID/);
    assert.throws(() => f.fence.database.batch([f.db.prepare("SELECT 1")]), /FOREIGN_STATEMENT/);
  } finally { f.sql.close(); }
});

test("source identity is frozen and unrelated problem controls do not block a restore", async () => {
  const f = fixture();
  try {
    (f.source.events[0] as { payloadJson: string }).payloadJson = "changed after creation";
    f.sql.exec("INSERT INTO content_controls VALUES('P-OTHER','problem','hidden')");
    assert.equal(await f.fence.matches(), true);
  } finally { f.sql.close(); }
});
