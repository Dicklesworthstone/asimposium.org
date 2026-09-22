import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deliverHeraldRooms, HERALD_DELIVERY_LIMITS, publicRoomHead,
  type HeraldDatabase, type HeraldNamespace,
} from "../../src/herald/outbox.ts";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, redacted_at TEXT, payload_json TEXT);
    CREATE TABLE workshop_objects(body TEXT);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');
    INSERT INTO problems VALUES ('P-DEMO', 1, 'active', 0), ('P-PRIVATE', 0, 'private-draft', 0);
    INSERT INTO events VALUES ('E-1', 'P-DEMO');
    INSERT INTO event_content VALUES ('E-1', NULL, 'PRIVATE-CONTENT-CANARY');`);
  sql.exec(readFileSync(new URL("../../../../db/migrations/0078_herald_room_outbox.sql", import.meta.url), "utf8"));
  const queries: string[] = [];
  const db: HeraldDatabase = { prepare(query) { queries.push(query); return { bind(...values) {
    return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
  } }; } };
  const calls: any[] = [];
  let send: (r: any) => Promise<Response> = async () => new Response(null, { status: 204 });
  const namespace: HeraldNamespace = { idFromName: (name) => name, get(id) {
    assert.ok(String(id).startsWith("public-problem-v1:"));
    return { fetch: async (r) => { calls.push(r.clone()); return send(r); } };
  } };
  const change = () => sql.exec("UPDATE problems SET public_seq=public_seq+1 WHERE id='P-DEMO'");
  const pending = () => sql.prepare("SELECT * FROM herald_room_outbox WHERE generation > delivered_generation").all() as { generation: number; delivered_generation: number; retry_at: number; attempts: number }[];
  return { sql, db, queries, calls, namespace, change, pending, send: (fn: typeof send) => { send = fn; } };
}
const NOW = 1_000_000;
describe("W7 coalesced transactional wake queue on real SQLite", () => {
  test("migration does not invent historical notifications or ledger events", () => {
    const f = fixture(); try { assert.equal(f.pending().length, 0); } finally { f.sql.close(); }
  });
  test("rollback rolls back the wake generation together with the public write", () => {
    const f = fixture(); try {
      f.sql.exec("BEGIN"); f.change(); assert.equal(f.pending().length, 1); f.sql.exec("ROLLBACK");
      assert.equal(f.pending().length, 0);
      assert.equal((f.sql.prepare("SELECT public_seq FROM problems WHERE id='P-DEMO'").get() as { public_seq: number }).public_seq, 1);
    } finally { f.sql.close(); }
  });
  test("many public commits coalesce to one pending row and one metadata-only nudge", async () => {
    const f = fixture(); try {
      for (let i = 0; i < 30; i++) f.change();
      assert.equal(f.pending().length, 1); assert.equal(f.pending()[0]!.generation, 30);
      const result = await deliverHeraldRooms(f.db, f.namespace, () => NOW);
      assert.equal(result.delivered, 1); assert.equal(f.calls.length, 1); assert.equal(f.pending().length, 0);
      assert.deepEqual(await f.calls[0]!.json(), { generation: 30 });
      assert.ok(!f.queries.join("\n").includes("payload_json"));
      assert.ok(!f.queries.join("\n").includes("workshop"));
    } finally { f.sql.close(); }
  });
  test("a commit racing delivery cannot be erased by the older acknowledgement", async () => {
    const f = fixture(); try {
      f.change(); f.send(async () => { f.change(); return new Response(null, { status: 204 }); });
      const result = await deliverHeraldRooms(f.db, f.namespace, () => NOW);
      assert.equal(result.superseded, 1); assert.equal(f.pending()[0]!.generation, 2);
      f.send(async () => new Response(null, { status: 204 }));
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW)).delivered, 1);
      assert.equal(f.pending().length, 0);
    } finally { f.sql.close(); }
  });
  test("refused or failed delivery remains retryable, with bounded backoff", async () => {
    const f = fixture(); try {
      f.change(); f.send(async () => new Response("PRIVATE-DRIVER-CANARY", { status: 503 }));
      const first = await deliverHeraldRooms(f.db, f.namespace, () => NOW);
      assert.equal(first.retry, 1); assert.equal(f.pending()[0]!.retry_at, NOW + 1000);
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW + 999)).scanned, 0);
      f.send(async () => new Response(null, { status: 204 }));
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW + 1000)).delivered, 1);
    } finally { f.sql.close(); }
  });
  test("slow failed delivery starts backoff after the attempt ends", async () => {
    const f = fixture(); let now = NOW;
    try {
      f.change(); f.send(async () => { now += 5000; return new Response(null, { status: 503 }); });
      const result = await deliverHeraldRooms(f.db, f.namespace, () => now);
      assert.equal(result.retry, 1); assert.equal(f.pending()[0]!.retry_at, NOW + 6000);
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => now)).scanned, 0);
    } finally { f.sql.close(); }
  });
  test("a failed old attempt cannot postpone a new generation", async () => {
    const f = fixture(); try {
      f.change(); f.send(async () => { f.change(); throw new Error("PRIVATE-TRANSPORT-CANARY"); });
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW)).retry, 1);
      assert.equal(f.pending()[0]!.generation, 2); assert.equal(f.pending()[0]!.retry_at, 0);
    } finally { f.sql.close(); }
  });
  test("already delivered rows remain as monotonic generation witnesses, not ABA-prone deletes", async () => {
    const f = fixture(); try {
      f.change(); await deliverHeraldRooms(f.db, f.namespace, () => NOW); f.change();
      assert.equal(f.pending()[0]!.generation, 2); assert.equal(f.pending()[0]!.delivered_generation, 1);
    } finally { f.sql.close(); }
  });
  test("workshop/private-draft edits do not enqueue public room wake-ups", () => {
    const f = fixture(); try {
      f.sql.exec("UPDATE workshop_objects SET body='NEW-PRIVATE-CANARY'; UPDATE problems SET public_seq=1 WHERE id='P-PRIVATE';");
      assert.equal(f.pending().length, 0);
    } finally { f.sql.close(); }
  });
  test("public-to-private and unlisting changes enqueue invalidation without advancing the cursor", () => {
    const f = fixture(); try {
      f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'; UPDATE problems SET status='private-draft' WHERE id='P-DEMO';");
      assert.equal(f.pending()[0]!.generation, 2);
    } finally { f.sql.close(); }
  });
  test("redaction, purging and content restoration enqueue same-cursor refresh", () => {
    const f = fixture(); try {
      f.sql.exec("UPDATE event_content SET redacted_at='2026-09-22T00:00:00.000Z'; DELETE FROM event_content; INSERT INTO event_content VALUES ('E-1',NULL,'PRIVATE-RESTORED-CANARY');");
      assert.equal(f.pending()[0]!.generation, 3);
      assert.ok(!JSON.stringify(f.pending()).includes("PRIVATE-"));
    } finally { f.sql.close(); }
  });
  test("replaying an unchanged projection does not manufacture a wake-up", () => {
    const f = fixture(); try { f.sql.exec("UPDATE problems SET public_seq=public_seq, unlisted=unlisted, status=status"); assert.equal(f.pending().length, 0); }
    finally { f.sql.close(); }
  });
  test("batch size bounds delivery work and subsequent calls resume pending rooms", async () => {
    const f = fixture(); try {
      for (let i = 0; i < 9; i++) f.sql.prepare("INSERT INTO problems VALUES (?,0,'active',0)").run(`P-${i}`);
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW)).scanned, HERALD_DELIVERY_LIMITS.batch);
      assert.equal(f.pending().length, 5);
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW)).scanned, 4);
      assert.equal((await deliverHeraldRooms(f.db, f.namespace, () => NOW)).scanned, 1);
    } finally { f.sql.close(); }
  });
  test("an unavailable room cannot monopolize later pending work", async () => {
    const f = fixture(); try {
      for (let i = 0; i < 6; i++) f.sql.prepare("INSERT INTO problems VALUES (?,0,'active',0)").run(`P-${i}`);
      f.send(async (request) => new Response(null, { status: request.url.includes("P-0/") ? 503 : 204 }));
      const one = await deliverHeraldRooms(f.db, f.namespace, () => NOW); assert.equal(one.retry, 1);
      const two = await deliverHeraldRooms(f.db, f.namespace, () => NOW); assert.equal(two.delivered, 2);
      assert.equal(f.pending().length, 1);
    } finally { f.sql.close(); }
  });
  test("namespace absent leaves delivery disabled without touching the database", async () => {
    const f = fixture(); try {
      const result = await deliverHeraldRooms(f.db, undefined, () => NOW);
      assert.equal(result.enabled, false); assert.equal(f.queries.length, 0);
    } finally { f.sql.close(); }
  });
  test("public head is current, read-only, problem-local and distinguishes no private existence", async () => {
    const f = fixture(); try {
      assert.deepEqual(await publicRoomHead(f.db, "P-DEMO"), { seq: 1 });
      f.change(); assert.deepEqual(await publicRoomHead(f.db, "P-DEMO"), { seq: 2 });
      assert.equal(await publicRoomHead(f.db, "P-PRIVATE"), null);
      assert.equal(await publicRoomHead(f.db, "P-MISSING"), null);
      f.sql.exec("UPDATE problems SET public_seq=1.5 WHERE id='P-DEMO'");
      await assert.rejects(() => publicRoomHead(f.db, "P-DEMO"), /HERALD_HEAD_UNAVAILABLE/);
    } finally { f.sql.close(); }
  });
});
