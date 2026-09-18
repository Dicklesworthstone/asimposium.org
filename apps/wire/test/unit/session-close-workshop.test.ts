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
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      sessionId: "S-1",
      problemId: "P-1",
      fellowId: "F-1",
      keep: [],
      discard: ["W-A"],
      closedAt: "2026-09-18T00:00:00.000Z",
    });
    f.sql.exec("UPDATE workshop_objects SET current_version=2 WHERE workshop_id='W-A'");
    await assert.rejects(
      f.db.batch([
        f.db.prepare("UPDATE sessions SET closed_at='closed' WHERE session_id='S-1'"),
        ...plan.statements,
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
