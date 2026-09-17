import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewQueueScience } from "../../src/discovery/review-queue-read.ts";
import type { RetryAdmission } from "../../src/ledger/dead-end-retries.ts";
import {
  RETRY_SCIENCE_BUDGET_SQL,
  verifyRetryClaimTransition,
} from "../../src/ledger/dead-end-retry-science.ts";
import type {
  ScientificDisposition,
  ScientificRow,
} from "../../src/ledger/scientific-disposition.ts";

// Real SQLite scope queries. Disposition outcomes are explicit fixtures: these
// test canonical-evaluator orchestration, not scientific validity themselves.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      actor_fellow_id TEXT,payload_sha256 TEXT);
    CREATE TABLE reviews(source_event_id TEXT,problem_id TEXT,review_id TEXT,source_seq INTEGER,target_claim_id TEXT);
    CREATE TABLE evidence(source_event_id TEXT,problem_id TEXT,evidence_id TEXT,source_seq INTEGER,bears_on_kind TEXT,bears_on_id TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,author_fellow_id TEXT,target_object TEXT);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);`);
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
  const digest = "a".repeat(64);
  sql
    .query("INSERT INTO events VALUES('C','P-DEMO',1,'claim.created','claim','C-1','F-1',?)")
    .run(digest);
  sql
    .query("INSERT INTO events VALUES('R','P-DEMO',3,'review.created','review','R-3','F-2',?)")
    .run(digest);
  sql.query("INSERT INTO reviews VALUES('R','P-DEMO','R-3',3,'C-1')").run();
  sql
    .query("INSERT INTO event_content VALUES('C',?,'{}',NULL),('R',?,'{}',NULL)")
    .run(digest, digest);
  const rows = [
    {
      claim_id: "C-1",
      event_id: "C",
      seq: 1,
      type: "claim.created",
      target_version: 1,
      payload_sha256: digest,
      payload_json: "{}",
    },
    {
      claim_id: "C-1",
      event_id: "R",
      seq: 3,
      type: "review.created",
      target_version: 1,
      payload_sha256: digest,
      payload_json: "{}",
    },
  ] as ScientificRow[];
  const cuts: number[][] = [];
  const science: ReviewQueueScience = {
    prepare(_db, problem, cursor, limit, target) {
      assert.equal(problem, "P-DEMO");
      assert.equal(cursor, 5);
      assert.equal(limit, 1);
      assert.equal(target.claimId, "C-1");
      return {
        async all() {
          return { results: rows };
        },
      } as ReturnType<ReviewQueueScience["prepare"]>;
    },
    async fold(events) {
      cuts.push(events.map((e) => e.seq));
      return {
        currentVersion: 1,
        stale: false,
        disposition: events.some((e) => e.seq === 3) ? "corroborated" : "open",
      } as ScientificDisposition;
    },
  };
  const row = {
    problem_id: "P-DEMO",
    event_id: "R",
    seq: 3,
    payload_sha256: digest,
    payload_json: "{}",
  } as RetryAdmission;
  return {
    sql,
    db,
    row,
    science,
    rows,
    cuts,
    verify: () => verifyRetryClaimTransition(db, row, "C-1", "corroborated", 5, science),
  };
}

test("claim reactivation requires a genuine before/after transition still holding at the captured cut", async () => {
  const f = fixture();
  try {
    assert.equal(await f.verify(), "holds");
    assert.deepEqual(f.cuts, [[1], [1, 3], [1, 3]]);
  } finally {
    f.sql.close();
  }
});
for (const kind of ["already-held", "lost-support", "revised", "stale"])
  test(`${kind} cannot reuse an old firing as live support`, async () => {
    const f = fixture();
    try {
      let calls = 0;
      f.science.fold = async () => {
        calls++;
        return {
          disposition:
            kind === "already-held"
              ? "corroborated"
              : calls === 1
                ? "open"
                : kind === "lost-support" && calls === 3
                  ? "disputed"
                  : "corroborated",
          currentVersion: kind === "revised" && calls === 3 ? 2 : 1,
          stale: kind === "stale" && calls === 3,
        } as ScientificDisposition;
      };
      assert.equal(await f.verify(), kind === "stale" ? "unavailable" : "not-held");
    } finally {
      f.sql.close();
    }
  });

test("firing must match canonical scientific event identity and content exactly", async () => {
  for (const change of [
    { event_id: "OTHER" },
    { payload_sha256: "b".repeat(64) },
    { payload_json: '{"different":true}' },
    { target_version: 0 },
  ]) {
    const f = fixture();
    try {
      const targetRow = f.rows[1];
      assert.ok(targetRow);
      Object.assign(targetRow, change);
      assert.equal(await f.verify(), "unavailable");
      assert.equal(f.cuts.length, 0);
    } finally {
      f.sql.close();
    }
  }
});

test("large claim histories are withheld before loading or folding bodies", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 255; i++)
      f.sql
        .query("INSERT INTO events VALUES(?,'P-DEMO',2,'claim.revised','claim','C-1','F-1','hash')")
        .run(`extra-${i}`);
    f.science.prepare = () => {
      assert.fail("oversized history materialized");
    };
    assert.equal(await f.verify(), "unavailable");
  } finally {
    f.sql.close();
  }
});

test("the byte budget cannot be bypassed by a small event count", async () => {
  const f = fixture();
  try {
    f.sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id='C'")
      .run("界".repeat(400000));
    f.science.prepare = () => {
      assert.fail("oversized bytes materialized");
    };
    assert.equal(await f.verify(), "unavailable");
  } finally {
    f.sql.close();
  }
});

test("unrelated claims, another problem and events after the cursor do not exhaust this claim's budget", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 300; n++)
      f.sql
        .query(
          "INSERT INTO events VALUES(?,'P-DEMO',2,'claim.created','claim','C-10','F-1','hash')",
        )
        .run(`other-${n}`);
    f.sql.exec(
      "INSERT INTO events VALUES('future','P-DEMO',6,'claim.revised','claim','C-1','F-1','hash')",
    );
    f.sql.exec(
      "INSERT INTO events VALUES('foreign','P-OTHER',2,'claim.revised','claim','C-1','F-1','hash')",
    );
    assert.equal(await f.verify(), "holds");
  } finally {
    f.sql.close();
  }
});

test("evidence and retractions are counted through exact canonical projection joins", async () => {
  const f = fixture();
  try {
    f.sql.exec(`INSERT INTO events VALUES('E','P-DEMO',4,'evidence.created','evidence','E-4','F-1','hash');
      INSERT INTO evidence VALUES('E','P-DEMO','E-4',4,'claim','C-1');
      INSERT INTO events VALUES('X','P-DEMO',5,'object.retracted','retraction','X-5','F-1','hash');
      INSERT INTO retractions VALUES('P-DEMO','X-5',5,'F-1','C-1@1');`);
    const budget = await f.db
      .prepare(RETRY_SCIENCE_BUDGET_SQL)
      .bind(JSON.stringify({ problem: "P-DEMO", claim: "C-1", through: 5 }))
      .first<{ events: number }>();
    assert.equal(budget?.events, 4);
    f.sql.exec("UPDATE retractions SET target_object='C-10@1'");
    const changed = await f.db
      .prepare(RETRY_SCIENCE_BUDGET_SQL)
      .bind(JSON.stringify({ problem: "P-DEMO", claim: "C-1", through: 5 }))
      .first<{ events: number }>();
    assert.equal(changed?.events, 3);
  } finally {
    f.sql.close();
  }
});

test("a canonical query returning an incomplete history is never partially evaluated", async () => {
  const f = fixture();
  try {
    f.rows.pop();
    assert.equal(await f.verify(), "unavailable");
    assert.equal(f.cuts.length, 0);
  } finally {
    f.sql.close();
  }
});

test("supporting content withdrawn during evaluation invalidates the retry before return", async () => {
  const f = fixture();
  try {
    const original = f.science.fold;
    f.science.fold = async (events) => {
      const result = await original(events);
      if (f.cuts.length === 3)
        f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='C'");
      return result;
    };
    assert.equal(await f.verify(), "unavailable");
  } finally {
    f.sql.close();
  }
});
