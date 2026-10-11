import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import {
  prepareSessionCloseWorkshopActions,
  SessionCloseWorkshopError,
} from "../../src/sessions/session-close-workshop.ts";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY,closed_at TEXT);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY,problem_id TEXT,fellow_id TEXT,session_id TEXT,
      workshop_seq INTEGER,type TEXT,title TEXT,body_md TEXT,cas_hash TEXT,relates_to_json TEXT,
      revision_json TEXT,current_version INTEGER,state TEXT,ledger_intent_json TEXT,updated_at TEXT);
    CREATE TABLE workshop_revisions(workshop_id TEXT,version INTEGER,problem_id TEXT,fellow_id TEXT,session_id TEXT,
      type TEXT,title TEXT,body_md TEXT,cas_hash TEXT,relates_to_json TEXT,ledger_intent_json TEXT,
      revision_json TEXT,revise_action TEXT,created_at TEXT,PRIMARY KEY(workshop_id,version));
    INSERT INTO sessions VALUES('S-1',NULL);
    INSERT INTO workshop_objects VALUES
      ('W-A','P-1','F-1','S-1',1,'scratch','a','body a',NULL,'[]',NULL,1,'open',NULL,NULL),
      ('W-B','P-1','F-1','S-1',2,'note','b','body b',NULL,'[]',NULL,1,'archived',NULL,NULL),
      ('W-X','P-1','F-X','S-1',3,'note','x','body x',NULL,'[]',NULL,1,'open',NULL,NULL);`);
  function prepare(text: string) {
    let values: any[] = [];
    return {
      bind(...v: any[]) {
        assert.ok(v.length <= 100, "D1 statements must stay within the parameter budget");
        values = v;
        return this;
      },
      async all() {
        return { results: sql.query(text).all(...values) };
      },
      async first() {
        return sql.query(text).get(...values) ?? null;
      },
      async run() {
        sql.query(text).all(...values);
        return { success: true };
      },
      exec() {
        return sql.query(text).all(...values);
      },
    };
  }
  const db = {
    prepare,
    async batch(stmts: any[]) {
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  return { sql, db };
}
async function using(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}

const closeInput = {
  sessionId: "S-1",
  problemId: "P-1",
  fellowId: "F-1",
  keep: [] as string[],
  discard: ["W-A"],
  closedAt: "2026-09-18T00:00:00.000Z",
};

test("keep and discard are versioned private transitions", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      sessionId: "S-1",
      problemId: "P-1",
      fellowId: "F-1",
      keep: ["W-B"],
      discard: ["W-A"],
      closedAt: "2026-09-18T00:00:00.000Z",
    });
    await f.db.batch([...plan.statements]);
    assert.deepEqual(
      f.sql
        .query(
          "SELECT workshop_id,state,current_version,workshop_seq FROM workshop_objects WHERE fellow_id='F-1' ORDER BY workshop_id",
        )
        .all(),
      [
        { workshop_id: "W-A", state: "discarded", current_version: 2, workshop_seq: 4 },
        { workshop_id: "W-B", state: "open", current_version: 2, workshop_seq: 3 },
      ],
    );
    assert.deepEqual(
      f.sql
        .query("SELECT workshop_id,revise_action FROM workshop_revisions ORDER BY workshop_id")
        .all(),
      [
        { workshop_id: "W-A", revise_action: "discard" },
        { workshop_id: "W-B", revise_action: "keep" },
      ],
    );
  }));

test("selection must be disjoint and owned", () =>
  using(async (f) => {
    await assert.rejects(
      prepareSessionCloseWorkshopActions(f.db, {
        sessionId: "S-1",
        problemId: "P-1",
        fellowId: "F-1",
        keep: ["W-A"],
        discard: ["W-A"],
        closedAt: "2026-09-18T00:00:00.000Z",
      }),
      SessionCloseWorkshopError,
    );
    await assert.rejects(
      prepareSessionCloseWorkshopActions(f.db, {
        sessionId: "S-1",
        problemId: "P-1",
        fellowId: "F-1",
        keep: ["W-X"],
        discard: [],
        closedAt: "2026-09-18T00:00:00.000Z",
      }),
      SessionCloseWorkshopError,
    );
  }));

test("a concurrent workshop edit aborts the complete batch", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    f.sql.exec("UPDATE workshop_objects SET current_version=2 WHERE workshop_id='W-A'");
    await assert.rejects(
      f.db.batch([
        f.db.prepare("UPDATE workshop_objects SET title='must roll back' WHERE workshop_id='W-X'"),
        ...plan.statements,
        f.db.prepare("UPDATE sessions SET closed_at='closed' WHERE session_id='S-1'"),
      ]),
      /SESSION_CLOSE_WORKSHOP_CHANGED/,
    );
    assert.deepEqual(f.sql.query("SELECT closed_at FROM sessions").get(), { closed_at: null });
    assert.deepEqual(
      f.sql
        .query("SELECT state,current_version FROM workshop_objects WHERE workshop_id='W-A'")
        .get(),
      { state: "open", current_version: 2 },
    );
    assert.deepEqual(f.sql.query("SELECT title FROM workshop_objects WHERE workshop_id='W-X'").get(), {
      title: "x",
    });
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
  }));

test("empty actions add no statements", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      sessionId: "S-1",
      problemId: "P-1",
      fellowId: "F-1",
      keep: [],
      discard: [],
      closedAt: "2026-09-18T00:00:00.000Z",
    });
    assert.equal(plan.statements.length, 0);
  }));

test("an unselected object's new sequence aborts close and a fresh retry succeeds", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    f.sql.exec("UPDATE workshop_objects SET workshop_seq=20,current_version=2 WHERE workshop_id='W-B'");
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
    assert.deepEqual(
      f.sql.query("SELECT current_version,workshop_seq FROM workshop_objects WHERE workshop_id='W-A'").get(),
      { current_version: 1, workshop_seq: 1 },
    );
    const retry = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    await f.db.batch([...retry.statements]);
    assert.deepEqual(
      f.sql.query("SELECT current_version,workshop_seq FROM workshop_objects WHERE workshop_id='W-A'").get(),
      { current_version: 2, workshop_seq: 21 },
    );
  }));

test("another session of the same fellow shares the sequence guard", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    f.sql.exec(`INSERT INTO sessions VALUES('S-2',NULL);
      INSERT INTO workshop_objects
        SELECT 'W-NEW',problem_id,fellow_id,'S-2',3,type,title,body_md,cas_hash,
          relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at
        FROM workshop_objects WHERE workshop_id='W-A'`);
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
  }));

test("unrelated fellow and problem sequences do not invalidate a close", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    f.sql.exec(`UPDATE workshop_objects SET workshop_seq=100 WHERE workshop_id='W-X';
      INSERT INTO workshop_objects
        SELECT 'W-OTHER','P-2',fellow_id,session_id,200,type,title,body_md,cas_hash,
          relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at
        FROM workshop_objects WHERE workshop_id='W-A'`);
    await f.db.batch([...plan.statements]);
    assert.deepEqual(
      f.sql.query("SELECT workshop_seq FROM workshop_objects WHERE workshop_id='W-A'").get(),
      { workshop_seq: 3 },
    );
  }));

test("large keep/discard selections use bounded bindings and preserve every revision", () =>
  using(async (f) => {
    const ids = Array.from({ length: 128 }, (_, i) => `W-BULK-${i}`);
    const insert = f.sql.query(`INSERT INTO workshop_objects
      SELECT ?,problem_id,fellow_id,session_id,?,type,title,body_md,cas_hash,
        relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at
      FROM workshop_objects WHERE workshop_id='W-A'`);
    for (const [index, id] of ids.entries()) insert.run(id, index + 3);
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      keep: ids.slice(0, 64),
      discard: ids.slice(64),
    });
    await f.db.batch([...plan.statements]);
    assert.deepEqual(
      f.sql.query("SELECT COUNT(*) AS n,COUNT(DISTINCT workshop_seq) AS unique_seq FROM workshop_objects WHERE current_version=2").get(),
      { n: 128, unique_seq: 128 },
    );
    assert.deepEqual(
      f.sql.query("SELECT revise_action,COUNT(*) AS n FROM workshop_revisions GROUP BY revise_action ORDER BY revise_action").all(),
      [{ revise_action: "discard", n: 64 }, { revise_action: "keep", n: 64 }],
    );
    assert.deepEqual(
      f.sql.query("SELECT MIN(workshop_seq) AS first,MAX(workshop_seq) AS last FROM workshop_objects WHERE current_version=2").get(),
      { first: 131, last: 258 },
    );
  }));

test("JSON-bound selection IDs cannot change the ownership query", () =>
  using(async (f) => {
    await assert.rejects(
      prepareSessionCloseWorkshopActions(f.db, {
        ...closeInput,
        discard: ["W-A') OR 1=1 --"],
      }),
      (error: unknown) => error instanceof SessionCloseWorkshopError && error.code === "NOT_FOUND",
    );
    assert.deepEqual(f.sql.query("SELECT COUNT(*) AS n FROM workshop_objects").get(), { n: 3 });
  }));

test("closing the session after planning invalidates all workshop actions", () =>
  using(async (f) => {
    const plan = await prepareSessionCloseWorkshopActions(f.db, closeInput);
    f.sql.exec("UPDATE sessions SET closed_at='already closed' WHERE session_id='S-1'");
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
  }));

test("large selection guards still reject a changed final head atomically", () =>
  using(async (f) => {
    const ids = Array.from({ length: 64 }, (_, i) => `W-GUARD-${i}`);
    const insert = f.sql.query(`INSERT INTO workshop_objects
      SELECT ?,problem_id,fellow_id,session_id,?,type,title,body_md,cas_hash,
        relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at
      FROM workshop_objects WHERE workshop_id='W-A'`);
    for (const [index, id] of ids.entries()) insert.run(id, index + 3);
    const plan = await prepareSessionCloseWorkshopActions(f.db, { ...closeInput, discard: ids });
    f.sql.query("UPDATE workshop_objects SET current_version=2 WHERE workshop_id=?").run(ids[63]);
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
  }));
