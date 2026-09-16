import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  parseEventTailQuery,
  renderEventTail,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import {
  type EventTailDatabase,
  EventTailReadError,
  readPublicEventTail,
} from "../../src/ledger/event-tail-read.ts";

function fixture(count = 0) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE workshop_objects (body TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'open', 0);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');`);
  const digest = "a".repeat(64);
  const queries: string[] = [];
  const db: EventTailDatabase = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  const append = (seq: number, kind = "claim", type = "claim.created", problem = "P-DEMO") => {
    const id = `${problem}-event-${seq}`;
    sql
      .prepare(
        "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'F-1', 'S-1', 'SES-1', 'model', 'harness', 'PRIVATE-CREDENTIAL-CANARY')",
      )
      .run(id, problem, seq, type, kind, `C-${seq}`, "2026-09-15T00:00:00.000Z", digest);
    sql
      .prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)")
      .run(id, digest, '{"secret":"PRIVATE-CONTENT-CANARY"}');
    sql.prepare("UPDATE problems SET public_seq=? WHERE id=?").run(seq, problem);
  };
  for (let i = 1; i <= count; i++) append(i);
  return { sql, db, append, queries };
}

async function expectCode(
  run: () => Promise<unknown>,
  code: "CURSOR_INVALID" | "EVENT_TAIL_UNAVAILABLE",
) {
  try {
    await run();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error instanceof EventTailReadError).toBe(true);
    expect((error as EventTailReadError).code).toBe(code);
  }
}

describe("W6.4 actual SQLite public event tail", () => {
  for (const count of [0, 1, 49, 50, 51, 199, 200, 201]) {
    test(`exact ${count}-event boundary with honest lookahead`, async () => {
      const f = fixture(count);
      try {
        const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 50 });
        if (!result) throw new Error("missing public problem");
        expect(result.page.events.length).toBe(Math.min(50, count));
        expect(result.page.page_end.next_cursor).toBe(Math.min(50, count));
        expect(result.page.page_end.has_more).toBe(count > 50);
        expect(result.page.page_end.through).toBe(count);
        expect(f.queries.length).toBe(1);
        expect(f.queries[0]).not.toContain("payload_json");
        expect(f.queries[0]).not.toContain("writer_credential_id");
      } finally {
        f.sql.close();
      }
    });
  }
  test("empty public problem has a terminal page, missing and private do not", async () => {
    const f = fixture();
    try {
      expect(await readPublicEventTail(f.db, "P-MISSING", { since: 0, limit: 10 })).toBeNull();
      f.sql.exec("UPDATE problems SET status='private-draft'");
      expect(await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 })).toBeNull();
    } finally {
      f.sql.close();
    }
  });
  test("unlisted direct reads retain noindex authority", async () => {
    const f = fixture(1);
    try {
      f.sql.exec("UPDATE problems SET unlisted=1");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.unlisted).toBe(true);
    } finally {
      f.sql.close();
    }
  });
  test("concurrent appends do not shift a pinned traversal; polling discovers them", async () => {
    const f = fixture(5);
    try {
      const first = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 2 });
      if (!first?.page.page_end.next) throw new Error("missing continuation");
      const seen = first.page.events.map((event) => event.seq);
      f.append(6);
      f.append(7);
      let next: string | null = first.page.page_end.next;
      let poll = first.page.page_end.poll;
      while (next !== null) {
        const query = parseEventTailQuery(new URL(next, "https://a.asimposium.org").searchParams);
        if (!query) throw new Error("invalid server continuation");
        const result = await readPublicEventTail(f.db, "P-DEMO", query);
        if (!result) throw new Error("lost public problem");
        expect(result.page.page_end.through).toBe(5);
        seen.push(...result.page.events.map((event) => event.seq));
        next = result.page.page_end.next;
        poll = result.page.page_end.poll;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      const query = parseEventTailQuery(new URL(poll, "https://a.asimposium.org").searchParams);
      if (!query) throw new Error("invalid poll link");
      const fresh = await readPublicEventTail(f.db, "P-DEMO", query);
      expect(fresh?.page.events.map((event) => event.seq)).toEqual([6, 7]);
    } finally {
      f.sql.close();
    }
  });
  test("unknown/private producers retain sequences, not identifiers or actor fields", async () => {
    const f = fixture(1);
    try {
      f.append(2, "workshop", "workshop.changed");
      f.append(3, "commentary", "commentary.posted");
      f.append(4, "claim", "claim.internal-secret");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      if (!result) throw new Error("missing problem");
      expect(result.page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      for (const entry of result.page.events.slice(1)) {
        expect(entry.event).toBeNull();
        expect(entry.body_omitted).toBe("undisclosed_event");
      }
      const body = renderEventTail(result.page, "ndjson");
      for (const secret of ["PRIVATE-", "workshop.changed", "commentary.posted", "internal-secret"])
        expect(body).not.toContain(secret);
      expect(result.page.page_end.next_cursor).toBe(4);
    } finally {
      f.sql.close();
    }
  });
  test("redaction retains only the immutable public envelope and changes output", async () => {
    const f = fixture(1);
    try {
      const before = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      f.sql.exec("UPDATE event_content SET redacted_at='2026-09-15T01:00:00.000Z'");
      const after = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10, through: 1 });
      expect(before?.page.events[0]?.body_omitted).toBe("separate_object_face");
      expect(after?.page.events[0]?.body_omitted).toBe("content_unavailable");
      expect(after?.page.events[0]?.event?.object_url).toBe(
        "/p/P-DEMO/claims/C-1@1.json?through=1",
      );
      expect(JSON.stringify(after)).not.toContain("PRIVATE-");
    } finally {
      f.sql.close();
    }
  });
  test("missing or digest-detached content never appears available", async () => {
    const f = fixture(2);
    try {
      f.sql.exec(
        "DELETE FROM event_content WHERE event_id='P-DEMO-event-1'; UPDATE event_content SET payload_sha256='mismatch'",
      );
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.body_omitted)).toEqual([
        "content_unavailable",
        "content_unavailable",
      ]);
    } finally {
      f.sql.close();
    }
  });
  test("other problems and unpublished events cannot bleed into a tail", async () => {
    const f = fixture(2);
    try {
      f.sql.exec("INSERT INTO problems VALUES ('P-OTHER', 0, 'open', 0)");
      f.append(1, "claim", "claim.created", "P-OTHER");
      f.append(3);
      f.sql.exec("UPDATE problems SET public_seq=2 WHERE id='P-DEMO'");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(JSON.stringify(result)).not.toContain("P-OTHER");
    } finally {
      f.sql.close();
    }
  });
  test("a missing sequence refuses instead of certifying a completed page", async () => {
    const f = fixture(3);
    try {
      f.sql.exec("DELETE FROM events WHERE seq=2");
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 2 }),
        "EVENT_TAIL_UNAVAILABLE",
      );
    } finally {
      f.sql.close();
    }
  });
  test("future or regressed cuts cannot skip undiscovered data", async () => {
    const f = fixture(3);
    try {
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 4, limit: 10 }),
        "CURSOR_INVALID",
      );
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 0, through: 4, limit: 10 }),
        "CURSOR_INVALID",
      );
    } finally {
      f.sql.close();
    }
  });
  test("malformed/overlong envelopes remain bounded sequence-only entries", async () => {
    const f = fixture(3);
    try {
      f.sql.prepare("UPDATE events SET object_id=? WHERE seq=1").run("x".repeat(100000));
      f.sql.exec(
        "UPDATE events SET created_at='2026-02-30T00:00:00.000Z' WHERE seq=2; UPDATE events SET payload_sha256='broken' WHERE seq=3",
      );
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.event)).toEqual([null, null, null]);
      expect(JSON.stringify(result).length < 2000).toBe(true);
    } finally {
      f.sql.close();
    }
  });
  test("privacy change wins even during a pinned traversal", async () => {
    const f = fixture(3);
    try {
      const first = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 1 });
      expect(first?.page.page_end.has_more).toBe(true);
      f.sql.exec("UPDATE problems SET status='private-draft'");
      expect(
        await readPublicEventTail(f.db, "P-DEMO", { since: 1, limit: 1, through: 3 }),
      ).toBeNull();
    } finally {
      f.sql.close();
    }
  });
  test("invalid programmatic inputs never touch the binding", async () => {
    const f = fixture();
    try {
      for (const query of [
        { since: -1, limit: 1 },
        { since: 0, limit: 201 },
        { since: 0, limit: 1, through: NaN },
      ])
        await expectCode(() => readPublicEventTail(f.db, "P-DEMO", query), "CURSOR_INVALID");
      await expectCode(
        () => readPublicEventTail(f.db, "../private", { since: 0, limit: 1 }),
        "CURSOR_INVALID",
      );
      expect(f.queries.length).toBe(0);
    } finally {
      f.sql.close();
    }
  });
});
