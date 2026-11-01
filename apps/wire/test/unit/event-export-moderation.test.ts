import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  collectPublicExportEvents,
  countWithheldExportPayloads,
  type PublicExportDatabase,
  type PublicExportEventRef,
  PublicExportNoticeRequiredError,
  PublicExportUnavailableError,
  readPublicExportCut,
  readPublicExportPayloadSnapshot,
  readPublicExportPayloads,
  revalidatePublicExportCut,
} from "../../src/ledger/event-export-snapshot.ts";

/** Exercise the production SELECTs, including current-control subqueries, on
 * actual SQLite. The adapter changes only D1's result shape, never the rows. */
function fixture(count = 1, kind = "claim") {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, payload_sha256 TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE screening_publications (event_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'open', 0);`);
  for (let seq = 1; seq <= count; seq++) {
    const payload = JSON.stringify({ statement: `WITHHELD-PROBLEM-CANARY-${seq}` });
    const hash = createHash("sha256").update(payload).digest("hex");
    sql
      .prepare(
        "INSERT INTO events (id, problem_id, seq, payload_sha256, object_kind, object_id) VALUES (?, 'P-DEMO', ?, ?, ?, ?)",
      )
      .run(`E-${seq}`, seq, hash, kind, `C-${seq}`);
    sql.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(`E-${seq}`, hash, payload);
  }
  sql.prepare("UPDATE problems SET public_seq=?").run(count);
  const db: PublicExportDatabase = {
    prepare(query) {
      return {
        bind(...values) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  const readPage = async (after: number, limit: number): Promise<PublicExportEventRef[]> =>
    sql
      .prepare(`SELECT id AS eventId, problem_id AS problemId, seq, payload_sha256 AS payloadSha256
      FROM events WHERE problem_id='P-DEMO' AND seq > ? ORDER BY seq LIMIT ?`)
      .all(after, limit) as PublicExportEventRef[];
  const control = (
    target: string,
    visibility: "hidden" | "visible",
    version: number,
    problem = "P-DEMO",
  ) =>
    sql
      .prepare("INSERT INTO content_controls VALUES (?, ?, ?, ?)")
      .run(problem, target, visibility, version);
  return { sql, db, readPage, control };
}

async function refused(run: () => Promise<unknown>) {
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof PublicExportUnavailableError &&
      error.message === "PUBLIC_EXPORT_UNAVAILABLE",
  );
}

describe("exact publication controls on complete public archives", () => {
  test("v4 binds required notices to exact payloads and detects any receipt inserted after capture", async () => {
    const f = fixture(2);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      const before = await readPublicExportPayloadSnapshot(f.db, cut, events);
      assert.equal(before.publicationReceiptCount, 0);
      const receipt = readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
          import.meta.url,
        ),
        "utf8",
      );
      f.sql.query("INSERT INTO screening_publications VALUES ('E-1', ?)").run(receipt);
      await refused(() => revalidatePublicExportCut(f.db, cut, before));
      const snapshot = await readPublicExportPayloadSnapshot(f.db, cut, events);
      assert.equal(snapshot.publicationReceiptCount, 1);
      assert.deepEqual(snapshot.notices, [
        {
          event_id: "E-1",
          seq: 1,
          payload_sha256: events[0]!.payloadSha256,
          screening_notice: JSON.parse(receipt).public_action,
        },
      ]);
      assert.equal(snapshot.payloads.get("E-1"), before.payloads.get("E-1"));
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut, snapshot), { unlisted: false });
      f.control("C-1@1", "hidden", 1);
      await refused(() => revalidatePublicExportCut(f.db, cut, snapshot));
      f.control("C-1@1", "visible", 2);
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut, snapshot), { unlisted: false });
    } finally {
      f.sql.close();
    }
  });

  test("a required screening notice cannot be dropped by v3 export or its final cache check", async () => {
    const f = fixture();
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 1);
      const receipt = readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
          import.meta.url,
        ),
        "utf8",
      );
      f.sql.query("INSERT INTO screening_publications VALUES ('E-1', ?)").run(receipt);
      await assert.rejects(
        () => readPublicExportPayloads(f.db, cut, events),
        PublicExportNoticeRequiredError,
      );
      await assert.rejects(
        () => revalidatePublicExportCut(f.db, cut),
        PublicExportNoticeRequiredError,
      );
      assert.equal(
        await countWithheldExportPayloads(f.db, "P-DEMO"),
        0,
        "warning format incompatibility must not invent a moderation hide",
      );
      assert.ok(f.sql.query("SELECT payload_json FROM event_content WHERE event_id='E-1'").get());
    } finally {
      f.sql.close();
    }
  });

  test("malformed screening evidence cannot become an unqualified export", async () => {
    const f = fixture();
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      f.sql.exec(`INSERT INTO screening_publications VALUES ('E-1', '{"outcome":"pass"}')`);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      await refused(() => revalidatePublicExportCut(f.db, cut));
    } finally {
      f.sql.close();
    }
  });

  for (const kind of [
    "claim",
    "hypothesis",
    "evidence",
    "review",
    "citation",
    "gap",
    "question",
    "conflict",
    "dead-end",
    "synthesis",
  ]) {
    for (const target of ["C-1", "C-1@1", "#1"]) {
      test(`${kind} ${target}: read, withheld count, final check and restoration agree`, async () => {
        const f = fixture(1, kind);
        try {
          const cut = await readPublicExportCut(f.db, "P-DEMO");
          const events = await collectPublicExportEvents(cut, f.readPage);
          const original = await readPublicExportPayloads(f.db, cut, events);
          f.control(target, "hidden", 1);
          assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 1);
          await refused(() => readPublicExportPayloads(f.db, cut, events));
          await refused(() => revalidatePublicExportCut(f.db, cut));
          f.control(target, "visible", 2);
          assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 0);
          assert.deepEqual(await readPublicExportPayloads(f.db, cut, events), original);
          assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
        } finally {
          f.sql.close();
        }
      });
    }
  }

  test("an object restore cannot override an independently hidden version or event", async () => {
    const f = fixture(1, "evidence");
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      for (const target of ["C-1", "C-1@1", "#1"]) f.control(target, "hidden", 1);
      f.control("C-1", "visible", 2);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      f.control("C-1@1", "visible", 2);
      await refused(() => revalidatePublicExportCut(f.db, cut));
      f.control("#1", "visible", 2);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 1);
    } finally {
      f.sql.close();
    }
  });

  test("unrelated versions, sequences and problems do not withhold an archive", async () => {
    const f = fixture(1, "review");
    try {
      f.control("C-1@2", "hidden", 1);
      f.control("#2", "hidden", 1);
      f.control("C-1@1", "hidden", 1, "P-OTHER");
      f.control("#1", "hidden", 1, "P-OTHER");
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 1);
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 0);
    } finally {
      f.sql.close();
    }
  });
});

describe("public exports honor whole-problem moderation at every read boundary", () => {
  for (const count of [0, 1, 51]) {
    test(`a hidden ${count}-event problem cannot establish an export cut`, async () => {
      const f = fixture(count);
      try {
        f.control("problem", "hidden", 1);
        await refused(() => readPublicExportCut(f.db, "P-DEMO"));
      } finally {
        f.sql.close();
      }
    });
    test(`a hide after collecting ${count} payloads defeats final revalidation`, async () => {
      const f = fixture(count);
      try {
        const cut = await readPublicExportCut(f.db, "P-DEMO");
        const events = await collectPublicExportEvents(cut, f.readPage);
        assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, count);
        f.control("problem", "hidden", 1);
        await refused(() => revalidatePublicExportCut(f.db, cut));
      } finally {
        f.sql.close();
      }
    });
  }

  for (const kind of ["claim", "evidence", "review", "citation", "dead-end", "problem"]) {
    test(`a hide after cut capture withholds ${kind} event payloads`, async () => {
      const f = fixture(1, kind);
      try {
        const cut = await readPublicExportCut(f.db, "P-DEMO");
        const events = await collectPublicExportEvents(cut, f.readPage);
        f.control("problem", "hidden", 1);
        await refused(() => readPublicExportPayloads(f.db, cut, events));
      } finally {
        f.sql.close();
      }
    });
  }

  test("hiding between payload chunks cannot return the accumulated prefix", async () => {
    const f = fixture(51);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      let payloadReads = 0;
      const interleaved: PublicExportDatabase = {
        prepare(query) {
          if (query.includes("SELECT e.id AS event_id") && ++payloadReads === 2)
            f.control("problem", "hidden", 1);
          return f.db.prepare(query);
        },
      };
      await refused(() => readPublicExportPayloads(interleaved, cut, events));
      assert.equal(payloadReads, 2);
    } finally {
      f.sql.close();
    }
  });

  test("a hidden problem reveals no withheld-event count, even with redactions", async () => {
    const f = fixture(2);
    try {
      f.sql.exec(
        "UPDATE event_content SET redacted_at='2026-10-15T00:00:00.000Z' WHERE event_id='E-1'",
      );
      f.control("C-2", "hidden", 1);
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 2);
      f.control("problem", "hidden", 1);
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 0);
      assert.equal(await countWithheldExportPayloads(f.db, "P-MISSING"), 0);
    } finally {
      f.sql.close();
    }
  });

  test("the latest control version, not insertion order, permits restoration", async () => {
    const f = fixture(51);
    try {
      f.control("problem", "visible", 2);
      f.control("problem", "hidden", 1);
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 51);
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 0);
      f.control("problem", "hidden", 3);
      await refused(() => readPublicExportCut(f.db, "P-DEMO"));
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      await refused(() => revalidatePublicExportCut(f.db, cut));
    } finally {
      f.sql.close();
    }
  });

  test("restoring a claim cannot override a hidden whole problem", async () => {
    const f = fixture();
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      f.control("C-1", "hidden", 1);
      f.control("C-1", "visible", 2);
      f.control("problem", "hidden", 1);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      await refused(() => revalidatePublicExportCut(f.db, cut));
    } finally {
      f.sql.close();
    }
  });

  test("restoring a problem does not restore individually hidden claims", async () => {
    const f = fixture();
    try {
      f.control("problem", "hidden", 1);
      f.control("problem", "visible", 2);
      f.control("C-1", "hidden", 1);
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      await refused(() => revalidatePublicExportCut(f.db, cut));
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 1);
    } finally {
      f.sql.close();
    }
  });

  test("another problem's controls do not block this public archive", async () => {
    const f = fixture();
    try {
      f.control("problem", "hidden", 100, "P-OTHER");
      f.control("C-1", "hidden", 100, "P-OTHER");
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 1);
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
      assert.equal(await countWithheldExportPayloads(f.db, "P-DEMO"), 0);
    } finally {
      f.sql.close();
    }
  });
});
