import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import {
  assertSessionClosePublicationPins,
  parseSessionCloseReplayState,
  readSessionClosePublications,
  SessionClosePublicationError,
} from "../../src/sessions/session-close-publications.ts";
import {
  prepareSessionCloseWorkshopActions,
  SessionCloseWorkshopError,
} from "../../src/sessions/session-close-workshop.ts";

function fixture() {
  const sql = new Database(":memory:");
  let readCount = 0;
  sql.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY,closed_at TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,type TEXT,object_kind TEXT);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY,problem_id TEXT,fellow_id TEXT,session_id TEXT,
      workshop_seq INTEGER,type TEXT,title TEXT,body_md TEXT,cas_hash TEXT,relates_to_json TEXT,
      revision_json TEXT,current_version INTEGER,state TEXT,ledger_intent_json TEXT,updated_at TEXT,
      publication_json TEXT CHECK(publication_json IS NULL OR
        (json_valid(publication_json) AND json_type(publication_json)='object')));
    CREATE TABLE workshop_revisions(workshop_id TEXT,version INTEGER,problem_id TEXT,fellow_id TEXT,session_id TEXT,
      type TEXT,title TEXT,body_md TEXT,cas_hash TEXT,relates_to_json TEXT,ledger_intent_json TEXT,
      revision_json TEXT,revise_action TEXT,created_at TEXT,publication_event_id TEXT,
      publication_json TEXT CHECK(publication_json IS NULL OR
        (json_valid(publication_json) AND json_type(publication_json)='object')),
      PRIMARY KEY(workshop_id,version));
    INSERT INTO sessions VALUES('S-1',NULL);
    INSERT INTO workshop_objects VALUES
      ('W-A','P-1','F-1','S-1',1,'scratch','a','body a',NULL,'[]',NULL,1,'open',NULL,NULL,NULL),
      ('W-B','P-1','F-1','S-1',2,'note','b','body b',NULL,'[]',NULL,1,'archived',NULL,NULL,NULL),
      ('W-X','P-1','F-X','S-1',3,'note','x','body x',NULL,'[]',NULL,1,'open',NULL,NULL,NULL);`);
  function prepare(text: string) {
    let values: any[] = [];
    return {
      bind(...v: any[]) {
        assert.ok(v.length <= 100, "D1 statements must stay within the parameter budget");
        values = v;
        return this;
      },
      async all() {
        readCount += 1;
        return { results: sql.query(text).all(...values) };
      },
      async first() {
        readCount += 1;
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
  return { sql, db, readCount: () => readCount };
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
    assert.deepEqual(plan.statementsAt("2026-09-18T00:10:00.000Z"), []);
    assert.equal(f.readCount(), 0);
  }));

test("timestamp rebinding preserves captured workshop guards without another read", async () => {
  for (const changedDuringScreening of [false, true]) {
    await using(async (f) => {
      const plan = await prepareSessionCloseWorkshopActions(f.db, {
        ...closeInput,
        keep: ["W-B"],
      });
      const readsBeforeScreening = f.readCount();
      assert.equal(readsBeforeScreening, 2);
      if (changedDuringScreening) {
        f.sql.exec("UPDATE workshop_objects SET current_version=2 WHERE workshop_id='W-A'");
      }
      const publishedAt = "2026-09-18T00:10:00.000Z";
      const statements = plan.statementsAt(publishedAt);
      assert.equal(statements.length, 3);
      assert.equal(f.readCount(), readsBeforeScreening);
      if (changedDuringScreening) {
        await assert.rejects(f.db.batch([...statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
        assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
        assert.deepEqual(
          f.sql.query("SELECT state,current_version,updated_at FROM workshop_objects WHERE workshop_id='W-B'").get(),
          { state: "archived", current_version: 1, updated_at: null },
        );
      } else {
        await f.db.batch([...statements]);
        assert.deepEqual(
          f.sql.query("SELECT workshop_id,updated_at FROM workshop_objects WHERE fellow_id='F-1' ORDER BY workshop_id").all(),
          [
            { workshop_id: "W-A", updated_at: publishedAt },
            { workshop_id: "W-B", updated_at: publishedAt },
          ],
        );
        assert.deepEqual(
          f.sql.query("SELECT workshop_id,created_at FROM workshop_revisions ORDER BY workshop_id").all(),
          [
            { workshop_id: "W-A", created_at: publishedAt },
            { workshop_id: "W-B", created_at: publishedAt },
          ],
        );
      }
    });
  }
});

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
          relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at,publication_json
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
          relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at,publication_json
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
        relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at,publication_json
      FROM workshop_objects WHERE workshop_id='W-A'`);
    for (const [index, id] of ids.entries()) insert.run(id, index + 3);
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      keep: ids.slice(0, 64),
      discard: ids.slice(64),
    });
    assert.equal(plan.statements.length, 3, "bulk closes must not issue two queries per draft");
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
        relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at,publication_json
      FROM workshop_objects WHERE workshop_id='W-A'`);
    for (const [index, id] of ids.entries()) insert.run(id, index + 3);
    const plan = await prepareSessionCloseWorkshopActions(f.db, { ...closeInput, discard: ids });
    const finalId = ids.at(-1);
    assert.ok(finalId);
    f.sql.query("UPDATE workshop_objects SET current_version=2 WHERE workshop_id=?").run(finalId);
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_revisions").all(), []);
  }));

test("a revision insert failure rolls back every head and the enclosing close", () =>
  using(async (f) => {
    f.sql.exec(`INSERT INTO workshop_revisions(workshop_id,version) VALUES('W-B',2)`);
    const before = f.sql.query("SELECT * FROM workshop_objects ORDER BY workshop_id").all();
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      keep: ["W-B"],
      discard: ["W-A"],
    });
    await assert.rejects(
      f.db.batch([
        ...plan.statements,
        f.db.prepare("UPDATE sessions SET closed_at='closed' WHERE session_id='S-1'"),
      ]),
      /UNIQUE constraint failed/,
    );
    assert.deepEqual(f.sql.query("SELECT * FROM workshop_objects ORDER BY workshop_id").all(), before);
    assert.deepEqual(f.sql.query("SELECT closed_at FROM sessions").get(), { closed_at: null });
    assert.deepEqual(f.sql.query("SELECT workshop_id,version FROM workshop_revisions").all(), [
      { workshop_id: "W-B", version: 2 },
    ]);
  }));

test("bulk snapshots preserve per-object bodies, metadata and selected sequence order", () =>
  using(async (f) => {
    f.sql.exec(`UPDATE workshop_objects SET
      cas_hash='hash-a',relates_to_json='["C-1@2"]',ledger_intent_json='{"kind":"claim"}',
      revision_json='{"base_version":1}' WHERE workshop_id='W-A'`);
    const before = f.sql.query(`SELECT workshop_id,type,title,body_md,cas_hash,
      relates_to_json,ledger_intent_json,revision_json FROM workshop_objects
      WHERE fellow_id='F-1' ORDER BY workshop_id`).all();
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      keep: ["W-B", "W-A"],
      discard: [],
    });
    await f.db.batch([...plan.statements]);
    assert.deepEqual(
      f.sql.query(`SELECT workshop_id,type,title,body_md,cas_hash,relates_to_json,
        ledger_intent_json,revision_json FROM workshop_revisions ORDER BY workshop_id`).all(),
      before,
    );
    assert.deepEqual(
      f.sql.query("SELECT workshop_id,workshop_seq FROM workshop_objects WHERE fellow_id='F-1' ORDER BY workshop_seq").all(),
      [{ workshop_id: "W-B", workshop_seq: 3 }, { workshop_id: "W-A", workshop_seq: 4 }],
    );
    assert.deepEqual(
      f.sql.query("SELECT DISTINCT created_at,revise_action FROM workshop_revisions").all(),
      [{ created_at: closeInput.closedAt, revise_action: "keep" }],
    );
  }));

for (const action of ["keep", "discard"] as const) {
  test(`${action} preserves structured publication drafts byte-for-byte in revision history`, () =>
    using(async (f) => {
      const publication = '{ "kind": "conjecture", "statement": "Every orbit closes.", "falsifier": "An escaping orbit." }';
      f.sql.query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-A'").run(publication);
      const plan = await prepareSessionCloseWorkshopActions(f.db, {
        ...closeInput,
        keep: action === "keep" ? ["W-A"] : [],
        discard: action === "discard" ? ["W-A"] : [],
      });
      await f.db.batch([...plan.statements]);
      assert.deepEqual(
        f.sql.query("SELECT version,publication_json,revise_action FROM workshop_revisions WHERE workshop_id='W-A'").get(),
        { version: 2, publication_json: publication, revise_action: action },
      );
      assert.deepEqual(
        f.sql.query("SELECT publication_json FROM workshop_objects WHERE workshop_id='W-A'").get(),
        { publication_json: publication },
      );
    }));
}

const closePublicationInput = {
  sessionId: "S-1",
  problemId: "P-1",
  fellowId: "F-1",
  promote: ["W-abcdefghijklmnopqrstuvwxyz"],
};

function saveClaimPublication(f: ReturnType<typeof fixture>, publication: string) {
  f.sql.exec("UPDATE workshop_objects SET workshop_id='W-abcdefghijklmnopqrstuvwxyz' WHERE workshop_id='W-A'");
  f.sql.query(
    "UPDATE workshop_objects SET type='claim-draft',publication_json=? WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  ).run(publication);
  f.sql.exec(
    "INSERT INTO workshop_revisions " +
    "(workshop_id,version,problem_id,fellow_id,session_id,publication_json) " +
    "SELECT workshop_id,current_version,problem_id,fellow_id,session_id,publication_json " +
    "FROM workshop_objects WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  );
}

const claimPublication = JSON.stringify({
  kind: "definition",
  statement: "The orbit boundary is the set of points fixed by both maps.",
});

test("close reads the selected immutable claim publication without publishing private notes", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    const [selected] = await readSessionClosePublications(f.db, closePublicationInput);
    assert.ok(selected);
    assert.deepEqual(selected.data, {
      kind: "definition",
      statement: "The orbit boundary is the set of points fixed by both maps.",
      relates_to: [],
      depends_on: [],
      workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
      expected_workshop_version: 1,
    });
    assert.equal(selected.publicationJson, claimPublication);
    assert.equal(selected.pin.workshopId, "W-abcdefghijklmnopqrstuvwxyz");
    assert.equal(selected.pin.version, 1);
    assert.match(selected.pin.publicationDigest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(selected).includes("body a"));
  }));

test("publication selection neither adopts a foreign Fellow's draft nor a missing source revision", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    await assert.rejects(
      readSessionClosePublications(f.db, { ...closePublicationInput, promote: ["W-X"] }),
      (error: unknown) => error instanceof SessionClosePublicationError && error.code === "NOT_FOUND",
    );
    f.sql.exec("UPDATE workshop_objects SET current_version=2 WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'");
    await assert.rejects(
      readSessionClosePublications(f.db, closePublicationInput),
      (error: unknown) => error instanceof SessionClosePublicationError && error.code === "INVALID_PUBLICATION",
    );
  }));

for (const mutation of [
  "UPDATE workshop_objects SET state='discarded' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_objects SET type='note' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_objects SET revision_json='{\"base_version\":1}' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_objects SET ledger_intent_json='{\"kind\":\"create\",\"target_kind\":\"evidence\"}' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_objects SET publication_json='{\"kind\":\"definition\",\"statement\":\"Replacement\"}' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
]) {
  test("close refuses an ineligible or changed publication: " + mutation, () =>
    using(async (f) => {
      saveClaimPublication(f, claimPublication);
      f.sql.exec(mutation);
      await assert.rejects(
        readSessionClosePublications(f.db, closePublicationInput),
        (error: unknown) => error instanceof SessionClosePublicationError && error.code === "INVALID_PUBLICATION",
      );
    }));
}

test("a pending close pins both the source version and its publication bytes", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    const original = await readSessionClosePublications(f.db, closePublicationInput);
    const pins = original.map((item) => item.pin);
    assertSessionClosePublicationPins(original, pins);
    f.sql.exec("UPDATE workshop_objects SET current_version=2 WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'");
    saveClaimPublication(f, claimPublication);
    const revised = await readSessionClosePublications(f.db, closePublicationInput);
    assert.throws(() => assertSessionClosePublicationPins(revised, pins), SessionClosePublicationError);
    f.sql.query("UPDATE workshop_objects SET publication_json=? WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'").run(
      JSON.stringify({ kind: "definition", statement: "A different boundary." }),
    );
    f.sql.exec(
      "UPDATE workshop_revisions SET publication_json=(SELECT publication_json FROM workshop_objects WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz') " +
      "WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz' AND version=2",
    );
    const changedBytes = await readSessionClosePublications(f.db, closePublicationInput);
    assert.throws(
      () => assertSessionClosePublicationPins(changedBytes, revised.map((item) => item.pin)),
      SessionClosePublicationError,
    );
  }));

test("close archives promoted claims, links their event, and keeps and discards other drafts atomically", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    f.sql.exec(
      "INSERT INTO workshop_objects SELECT 'W-C',problem_id,fellow_id,session_id,3,type,title,body_md,cas_hash," +
      "relates_to_json,revision_json,current_version,state,ledger_intent_json,updated_at,publication_json " +
      "FROM workshop_objects WHERE workshop_id='W-B'",
    );
    f.sql.exec("INSERT INTO events VALUES('E-publication','P-1','claim.created','claim')");
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      promote: [{
        workshopId: "W-abcdefghijklmnopqrstuvwxyz",
        expectedVersion: 1,
        publicationJson: claimPublication,
        eventId: "E-publication",
      }],
      keep: ["W-B"],
      discard: ["W-C"],
    });
    assert.equal(plan.statements.length, 3);
    await f.db.batch([
      ...plan.statements,
      f.db.prepare("UPDATE sessions SET closed_at='closed' WHERE session_id='S-1'"),
    ]);
    assert.deepEqual(
      f.sql.query(
        "SELECT workshop_id,state,current_version,workshop_seq FROM workshop_objects WHERE fellow_id='F-1' ORDER BY workshop_id",
      ).all(),
      [
        { workshop_id: "W-abcdefghijklmnopqrstuvwxyz", state: "archived", current_version: 2, workshop_seq: 4 },
        { workshop_id: "W-B", state: "open", current_version: 2, workshop_seq: 5 },
        { workshop_id: "W-C", state: "discarded", current_version: 2, workshop_seq: 6 },
      ],
    );
    assert.deepEqual(
      f.sql.query(
        "SELECT revise_action,publication_event_id,publication_json FROM workshop_revisions WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz' AND version=2",
      ).get(),
      { revise_action: "archive", publication_event_id: "E-publication", publication_json: claimPublication },
    );
  }));

test("close selections must be unique and disjoint across promote, keep and discard", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    await assert.rejects(
      prepareSessionCloseWorkshopActions(f.db, {
        ...closeInput,
        promote: [{
          workshopId: "W-abcdefghijklmnopqrstuvwxyz", expectedVersion: 1,
          publicationJson: claimPublication, eventId: "E-publication",
        }],
        keep: ["W-abcdefghijklmnopqrstuvwxyz"],
        discard: [],
      }),
      (error: unknown) => error instanceof SessionCloseWorkshopError && error.code === "INVALID_SELECTION",
    );
  }));

for (const mutation of [
  "UPDATE workshop_objects SET state='archived' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_revisions SET publication_json='{\"kind\":\"definition\",\"statement\":\"Replaced source\"}' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
  "UPDATE workshop_objects SET publication_json='{\"kind\":\"definition\",\"statement\":\"Replaced head\"}' WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'",
]) {
  test("a late publication change rolls back its event, sibling actions and close: " + mutation, () =>
    using(async (f) => {
      saveClaimPublication(f, claimPublication);
      const plan = await prepareSessionCloseWorkshopActions(f.db, {
        ...closeInput,
        promote: [{
          workshopId: "W-abcdefghijklmnopqrstuvwxyz", expectedVersion: 1,
          publicationJson: claimPublication, eventId: "E-publication",
        }],
        keep: ["W-B"],
        discard: [],
      });
      f.sql.exec(mutation);
      await assert.rejects(
        f.db.batch([
          f.db.prepare("INSERT INTO events VALUES('E-publication','P-1','claim.created','claim')"),
          ...plan.statements,
          f.db.prepare("UPDATE sessions SET closed_at='closed' WHERE session_id='S-1'"),
        ]),
        /SESSION_CLOSE_WORKSHOP_CHANGED/,
      );
      assert.deepEqual(f.sql.query("SELECT * FROM events").all(), []);
      assert.deepEqual(f.sql.query("SELECT closed_at FROM sessions").get(), { closed_at: null });
      assert.deepEqual(
        f.sql.query("SELECT state,current_version FROM workshop_objects WHERE workshop_id='W-B'").get(),
        { state: "archived", current_version: 1 },
      );
    }));
}

test("a workshop archive cannot commit without its matching claim event", () =>
  using(async (f) => {
    saveClaimPublication(f, claimPublication);
    const plan = await prepareSessionCloseWorkshopActions(f.db, {
      ...closeInput,
      promote: [{
        workshopId: "W-abcdefghijklmnopqrstuvwxyz", expectedVersion: 1,
        publicationJson: claimPublication, eventId: "E-missing",
      }],
      discard: [],
    });
    await assert.rejects(f.db.batch([...plan.statements]), /SESSION_CLOSE_WORKSHOP_CHANGED/);
    assert.deepEqual(
      f.sql.query("SELECT state,current_version FROM workshop_objects WHERE workshop_id='W-abcdefghijklmnopqrstuvwxyz'").get(),
      { state: "open", current_version: 1 },
    );
  }));


test("pending close receipts preserve opaque source pins and reject malformed internal states", () => {
  const pending = {
    kind: "session-close-pending-v1",
    reservation: "R-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    publications: [{
      workshopId: "W-abcdefghijklmnopqrstuvwxyz",
      version: 1,
      publicationDigest: "a".repeat(64),
      eventId: "E-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }],
  };
  assert.deepEqual(parseSessionCloseReplayState(JSON.stringify(pending)), pending);
  for (const malformed of [
    { ...pending, publications: [] },
    { ...pending, publications: [...pending.publications, ...pending.publications] },
    { ...pending, publications: [{ ...pending.publications[0], publicationDigest: "bad" }] },
    { ...pending, publications: [{ ...pending.publications[0], statement: "not a pin" }] },
    { ...pending, reservation: "caller-supplied-key" },
  ]) {
    assert.throws(() => parseSessionCloseReplayState(JSON.stringify(malformed)));
  }
  const completed = JSON.stringify({
    session_id: "S-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    closed_at: "2026-10-19T00:00:00.000Z",
    promoted: ["C-12"],
  });
  assert.deepEqual(parseSessionCloseReplayState(completed), { kind: "completed", plaintext: completed });
});
