import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPublicEventFeed } from "../../src/ledger/event-feed-read.ts";
import { type EventTailDatabase, EventTailReadError } from "../../src/ledger/event-tail-read.ts";

function fixture(count = 0) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'open', 0);`);
  const digest = "a".repeat(64);
  const append = (seq: number) => {
    sql
      .prepare(
        "INSERT INTO events VALUES (?, 'P-DEMO', ?, 'claim.created', 'claim', ?, 1, ?, ?, 'F-1', 'S-1', 'SES-1', 'model', 'harness')",
      )
      .run(`event-${seq}`, seq, `C-${seq}`, "2026-09-15T00:00:00.000Z", digest);
    sql
      .prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)")
      .run(`event-${seq}`, digest, '{"private":"PRIVATE-BODY-CANARY"}');
    sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(seq);
  };
  for (let seq = 1; seq <= count; seq++) append(seq);
  const queries: string[] = [];
  let afterHead: (() => void) | undefined;
  const db: EventTailDatabase = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return {
            all: async <T>() => {
              const results = sql.prepare(query).all(...values) as T[];
              if (queries.length === 1) afterHead?.();
              return { results };
            },
          };
        },
      };
    },
  };
  return {
    sql,
    db,
    queries,
    append,
    betweenReads: (run: () => void) => {
      afterHead = run;
    },
  };
}

async function unavailable(run: () => Promise<unknown>) {
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof EventTailReadError && error.code === "EVENT_TAIL_UNAVAILABLE",
  );
}

describe("recent public feed window on actual SQLite", () => {
  for (const count of [0, 1, 199, 200, 201, 450]) {
    test(`newest bounded window at ${count} events`, async () => {
      const f = fixture(count);
      try {
        const result = await readPublicEventFeed(f.db, "P-DEMO");
        assert.ok(result);
        const since = Math.max(0, count - 200);
        assert.deepEqual(
          result.page.events.map((e) => e.seq),
          Array.from({ length: count - since }, (_, i) => since + i + 1),
        );
        assert.equal(result.page.page_end.since, since);
        assert.equal(result.page.page_end.through, count);
        assert.equal(result.page.page_end.next_cursor, count);
        assert.equal(result.page.page_end.has_more, false);
        assert.equal(result.page.page_end.next, null);
        assert.equal(f.queries.length, 2);
        assert.ok(f.queries.every((query) => !query.includes("payload_json")));
        assert.ok(!JSON.stringify(result).includes("PRIVATE-BODY-CANARY"));
      } finally {
        f.sql.close();
      }
    });
  }
  test("appends between reads wait until the next refresh without shifting the window", async () => {
    const f = fixture(201);
    try {
      f.betweenReads(() => {
        f.append(202);
        f.append(203);
      });
      const pinned = await readPublicEventFeed(f.db, "P-DEMO");
      assert.equal(pinned?.page.page_end.through, 201);
      assert.equal(pinned?.page.events[0]?.seq, 2);
      assert.equal(pinned?.page.events.at(-1)?.seq, 201);
      const next = await readPublicEventFeed(f.db, "P-DEMO");
      assert.equal(next?.page.page_end.through, 203);
      assert.equal(next?.page.events[0]?.seq, 4);
      assert.equal(next?.page.events.at(-1)?.seq, 203);
    } finally {
      f.sql.close();
    }
  });
  test("privacy changes between reads suppress the feed", async () => {
    const f = fixture(201);
    try {
      f.betweenReads(() => f.sql.exec("UPDATE problems SET status='private-draft'"));
      assert.equal(await readPublicEventFeed(f.db, "P-DEMO"), null);
    } finally {
      f.sql.close();
    }
  });
  test("unlisting between reads retains fresh no-store authority", async () => {
    const f = fixture(1);
    try {
      f.betweenReads(() => f.sql.exec("UPDATE problems SET unlisted=1"));
      assert.equal((await readPublicEventFeed(f.db, "P-DEMO"))?.unlisted, true);
    } finally {
      f.sql.close();
    }
  });
  test("unknown producers and unavailable content retain canonical omission behavior", async () => {
    const f = fixture(201);
    try {
      f.sql.exec(
        "UPDATE events SET object_kind='workshop', type='workshop.changed' WHERE seq=200; UPDATE event_content SET redacted_at='2026-09-16T00:00:00.000Z' WHERE event_id='event-201'",
      );
      const result = await readPublicEventFeed(f.db, "P-DEMO");
      assert.equal(result?.page.events.at(-2)?.event, null);
      assert.equal(result?.page.events.at(-1)?.body_omitted, "content_unavailable");
      assert.ok(!JSON.stringify(result).includes("workshop.changed"));
      assert.ok(!JSON.stringify(result).includes("PRIVATE-BODY-CANARY"));
    } finally {
      f.sql.close();
    }
  });
  test("gaps inside the recent window fail closed", async () => {
    const f = fixture(450);
    try {
      f.sql.exec("DELETE FROM events WHERE seq=300");
      await unavailable(() => readPublicEventFeed(f.db, "P-DEMO"));
    } finally {
      f.sql.close();
    }
  });
  test("missing and private problems do not start a second read", async () => {
    const f = fixture(1);
    try {
      assert.equal(await readPublicEventFeed(f.db, "P-MISSING"), null);
      assert.equal(f.queries.length, 1);
      f.sql.exec("UPDATE problems SET status='private-draft'");
      assert.equal(await readPublicEventFeed(f.db, "P-DEMO"), null);
      assert.equal(f.queries.length, 2);
    } finally {
      f.sql.close();
    }
  });
  for (const head of [-1, 1.5, 9007199254740992, "not-a-cursor", null]) {
    test(`malformed stored head ${String(head)} cannot select a window`, async () => {
      const f = fixture();
      try {
        f.sql.prepare("UPDATE problems SET public_seq=?").run(head);
        await unavailable(() => readPublicEventFeed(f.db, "P-DEMO"));
        assert.equal(f.queries.length, 1);
      } finally {
        f.sql.close();
      }
    });
  }
  test("invalid identifier is refused before database work", async () => {
    const f = fixture();
    try {
      await assert.rejects(
        () => readPublicEventFeed(f.db, "../private"),
        (error: unknown) => error instanceof EventTailReadError && error.code === "CURSOR_INVALID",
      );
      assert.equal(f.queries.length, 0);
    } finally {
      f.sql.close();
    }
  });
  test("both dedicated and negotiated feed mounts use the recent reader", () => {
    const router = readFileSync(
      new URL("../../src/ledger/event-tail-router.ts", import.meta.url),
      "utf8",
    );
    assert.equal(router.match(/await readPublicEventFeed\(c\.env\.DB, id\)/g)?.length, 2);
    assert.ok(!router.includes("readPublicEventTail(c.env.DB, id, { since: 0, limit: 200 })"));
  });
});
