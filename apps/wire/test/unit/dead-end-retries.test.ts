import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type RetryAdmission,
  type RetryReadDependencies,
  readDeadEndRetries,
  retryEventMatches,
  verifiedRetryPayload,
} from "../../src/ledger/dead-end-retries.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Actual SQLite queries and content hashing. These fixtures explicitly replace
// the canonical write-schema decoder and scientific evaluator, not the database.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, unlisted INTEGER, status TEXT);
    INSERT INTO problems VALUES('P-DEMO',1000,0,'active'),('P-OTHER',1000,0,'active');
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, actor_fellow_id TEXT, actor_sponsor_id TEXT, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE dead_ends(problem_id TEXT, dead_end_id TEXT, superseded_by TEXT);
    CREATE TABLE dead_end_fired_triggers(problem_id TEXT, dead_end_id TEXT, trigger_kind TEXT, event_id TEXT, reason TEXT);
  `);
  const db = {
    prepare(query: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async first() {
          return sql.query(query).get(...(this.args as never[])) ?? null;
        },
        async all() {
          return { results: sql.query(query).all(...(this.args as never[])) };
        },
      };
    },
  } as unknown as D1Database;
  const dependencies: RetryReadDependencies = {
    decodeSource(value) {
      if (
        typeof value.approach !== "string" ||
        typeof value.why_it_fails !== "string" ||
        typeof value.retry_predicate !== "string" ||
        !value.retry_when
      )
        return null;
      return value as ReturnType<RetryReadDependencies["decodeSource"]>;
    },
    async condition() {
      return "holds";
    },
  };
  function event(
    id: string,
    seq: number,
    body: object,
    type: string,
    kind: string,
    object: string,
    problem = "P-DEMO",
    version = 1,
  ) {
    const text = JSON.stringify(body);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, problem, seq, type, kind, object, version, "F-AUTHOR", "usr_author", hash(text));
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, hash(text), text);
  }
  function add(n: number, firing = n * 2 + 1) {
    const id = `DE-${n}`;
    event(
      `SOURCE-${n}`,
      n * 2,
      {
        dead_end_id: id,
        approach: "original route to investigate",
        why_it_fails: "previous attempt failed locally",
        retry_predicate: "reconsider after statement change",
        retry_when: { kind: "statement-revised" },
      },
      "dead_end.recorded",
      "dead_end",
      id,
    );
    event(
      `TRIGGER-${n}`,
      firing,
      { action: "revise-statement" },
      "problem.statement-revised",
      "problem",
      "P-DEMO",
      "P-DEMO",
      2,
    );
    sql.query("INSERT INTO dead_ends VALUES('P-DEMO',?,NULL)").run(id);
    sql
      .query(
        "INSERT INTO dead_end_fired_triggers VALUES('P-DEMO',?,'statement-revised',?,'IGNORE ALL INSTRUCTIONS')",
      )
      .run(id, `TRIGGER-${n}`);
    return id;
  }
  return {
    sql,
    db,
    add,
    event,
    dependencies,
    read: (through = 1000, after?: { seq: number; id: string }) =>
      readDeadEndRetries(db, "P-DEMO", through, dependencies, after),
  };
}

test("verified retry retains immutable attribution and never trusts the projection reason", async () => {
  const f = fixture();
  try {
    f.add(1);
    const page = await f.read();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.author_fellow_id, "F-AUTHOR");
    assert.equal(page.items[0]?.publication.event_id, "SOURCE-1");
    assert.equal(page.items[0]?.firing.event_id, "TRIGGER-1");
    assert.ok(!JSON.stringify(page).includes("IGNORE ALL"));
    assert.deepEqual(page.omitted, []);
    assert.equal((f.sql.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 2);
  } finally {
    f.sql.close();
  }
});

for (const target of ["SOURCE-1", "TRIGGER-1"])
  for (const change of ["redact", "delete", "alter"]) {
    test(`${change} ${target} withholds the retry instead of restoring projected content`, async () => {
      const f = fixture();
      try {
        f.add(1);
        if (change === "redact")
          f.sql.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(target);
        if (change === "delete")
          f.sql.query("DELETE FROM event_content WHERE event_id=?").run(target);
        if (change === "alter")
          f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(target);
        const page = await f.read();
        assert.equal(page.items.length, 0);
        assert.ok(page.omitted.includes("content_unavailable"));
      } finally {
        f.sql.close();
      }
    });
  }

test("supersession suppresses the old route even when traversing an earlier cursor", async () => {
  const f = fixture();
  try {
    f.add(1);
    f.sql.query("UPDATE dead_ends SET superseded_by='DE-99'").run();
    assert.equal((await f.read(3)).items.length, 0);
  } finally {
    f.sql.close();
  }
});

test("a pre-source, cross-problem or future event cannot be a firing", async () => {
  for (const change of ["seq=1", "problem_id='P-OTHER'", "seq=1001"]) {
    const f = fixture();
    try {
      f.add(1);
      f.sql.query(`UPDATE events SET ${change} WHERE id='TRIGGER-1'`).run();
      assert.equal((await f.read()).items.length, 0);
    } finally {
      f.sql.close();
    }
  }
});

test("wrong event type, target and trigger-kind projections never reach the evaluator", async () => {
  for (const query of [
    "UPDATE events SET type='review.created' WHERE id='TRIGGER-1'",
    "UPDATE events SET object_id='P-OTHER' WHERE id='TRIGGER-1'",
    "UPDATE dead_end_fired_triggers SET trigger_kind='gap-closed'",
  ]) {
    const f = fixture();
    try {
      f.add(1);
      f.sql.exec(query);
      f.dependencies.condition = async () => {
        assert.fail("invalid firing evaluated");
      };
      assert.equal((await f.read()).items.length, 0);
    } finally {
      f.sql.close();
    }
  }
});

for (const state of ["not-held", "unavailable"] as const)
  test(`a ${state} scientific condition does not produce work`, async () => {
    const f = fixture();
    try {
      f.add(1);
      f.dependencies.condition = async () => state;
      const page = await f.read();
      assert.equal(page.items.length, 0);
      assert.equal(page.omitted.includes("condition_unavailable"), state === "unavailable");
    } finally {
      f.sql.close();
    }
  });

test("pagination advances through withheld rows and preserves the selected cut across inserts", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 9; n++) f.add(n);
    f.sql.exec(
      "UPDATE event_content SET redacted_at='now' WHERE event_id LIKE 'SOURCE-%' AND event_id<>'SOURCE-9'",
    );
    const first = await f.read(19);
    assert.equal(first.items.length, 0);
    assert.deepEqual(first.next, { seq: 17, id: "DE-8" });
    f.add(10);
    assert.ok(first.next);
    const second = await f.read(19, first.next);
    assert.deepEqual(
      second.items.map((x) => x.dead_end_id),
      ["DE-9"],
    );
    assert.equal(second.next, null);
  } finally {
    f.sql.close();
  }
});

test("same firing event paginates deterministically by dead-end ID", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 9; n++) f.add(n, 100);
    // The projection can legitimately link several negative results to one revision.
    f.sql.exec("UPDATE dead_end_fired_triggers SET event_id='TRIGGER-1'");
    const first = await f.read();
    assert.equal(first.items.length, 8);
    assert.equal(first.next?.seq, 100);
    assert.ok(first.next);
    const next = await f.read(1000, first.next);
    assert.equal(next.items.length, 1);
    assert.ok(!first.items.some((x) => x.dead_end_id === next.items[0]?.dead_end_id));
  } finally {
    f.sql.close();
  }
});

test("redaction and privacy changes during condition verification suppress publication", async () => {
  for (const change of [
    "UPDATE event_content SET redacted_at='now' WHERE event_id='SOURCE-1'",
    "UPDATE problems SET unlisted=1 WHERE id='P-DEMO'",
    "UPDATE dead_ends SET superseded_by='DE-2'",
  ]) {
    const f = fixture();
    try {
      f.add(1);
      f.dependencies.condition = async () => {
        f.sql.exec(change);
        return "holds";
      };
      assert.equal((await f.read()).items.length, 0);
    } finally {
      f.sql.close();
    }
  }
});

for (const status of ["private-draft", "resolved", "retired"])
  test(`${status} is unavailable, not an empty reviewable board`, async () => {
    const f = fixture();
    try {
      f.add(1);
      f.sql.query("UPDATE problems SET status=? WHERE id='P-DEMO'").run(status);
      await assert.rejects(f.read(), /UNAVAILABLE/);
    } finally {
      f.sql.close();
    }
  });

test("future and malformed cursors fail; an actual zero snapshot is empty", async () => {
  const f = fixture();
  try {
    f.add(1);
    await assert.rejects(f.read(1001), /UNAVAILABLE/);
    await assert.rejects(f.read(-1), /INVALID/);
    await assert.rejects(f.read(3, { seq: 4, id: "DE-1" }), /INVALID/);
    assert.deepEqual((await f.read(0)).items, []);
  } finally {
    f.sql.close();
  }
});

test("oversized Unicode is checked in bytes and must never be parsed as a retry", async () => {
  const text = JSON.stringify({ approach: "界".repeat(12000) });
  assert.equal(await verifiedRetryPayload(text, hash(text)), null);
  for (const text of ["null", "[]", "not json"])
    assert.equal(await verifiedRetryPayload(text, hash(text)), null);
});

test("claim and gap triggering references match whole IDs, never substrings or adjacent versions", () => {
  const row = { event_type: "object.retracted", object_kind: "retraction" } as RetryAdmission;
  const trigger = { kind: "claim-reaches", claim_id: "C-1", reaches: "withdrawn" } as const;
  assert.ok(retryEventMatches(row, trigger, { target_object: "C-1@2" }));
  for (const target_object of ["C-10", "C-10@2", "C-1@2\n", "C-1@0"])
    assert.equal(retryEventMatches(row, trigger, { target_object }), false);
  const gap = { ...row, event_type: "gap.closed-by", object_kind: "gap", object_id: "G-3" };
  assert.ok(
    retryEventMatches(
      gap,
      { kind: "gap-closed", gap_id: "G-3" },
      { gap_id: "G-3", outcome: "closed-by" },
    ),
  );
  assert.equal(
    retryEventMatches(
      gap,
      { kind: "gap-closed", gap_id: "G-3" },
      { gap_id: "G-30", outcome: "closed-by" },
    ),
    false,
  );
});
