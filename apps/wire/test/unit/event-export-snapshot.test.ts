import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  collectPublicExportEvents,
  PUBLIC_EXPORT_MAX_EVENTS,
  type PublicExportDatabase,
  type PublicExportEventRef,
  PublicExportUnavailableError,
  readPublicExportCut,
  readPublicExportPayloads,
  revalidatePublicExportCut,
} from "../../src/ledger/event-export-snapshot.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(count = 0) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, payload_sha256 TEXT,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'open', 0);`);
  const append = (seq: number, payload = JSON.stringify({ statement: `Claim ${seq}: λ 🔬` })) => {
    const hash = sha(payload);
    sql.prepare("INSERT INTO events VALUES (?, 'P-DEMO', ?, ?)").run(`E-${seq}`, seq, hash);
    sql.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(`E-${seq}`, hash, payload);
    sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(seq);
  };
  for (let seq = 1; seq <= count; seq++) append(seq);
  const queries: string[] = [];
  const db: PublicExportDatabase = {
    prepare(query) {
      queries.push(query);
      return {
        bind(...values) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  const readPage = async (afterSeq: number, limit: number): Promise<PublicExportEventRef[]> =>
    sql
      .prepare(`SELECT id AS eventId, problem_id AS problemId, seq, payload_sha256 AS payloadSha256
      FROM events WHERE problem_id='P-DEMO' AND seq > ? ORDER BY seq LIMIT ?`)
      .all(afterSeq, limit) as PublicExportEventRef[];
  return { sql, db, queries, append, readPage };
}
async function refused(run: () => Promise<unknown>) {
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof PublicExportUnavailableError &&
      error.message === "PUBLIC_EXPORT_UNAVAILABLE",
  );
}

describe("finite and currently public export snapshots on actual SQLite", () => {
  for (const count of [0, 1, 49, 50, 51, 199, 200, 201]) {
    test(`exact ${count}-event export with complete digest-bound payloads`, async () => {
      const f = fixture(count);
      try {
        const cut = await readPublicExportCut(f.db, "P-DEMO");
        const events = await collectPublicExportEvents(cut, f.readPage);
        const payloads = await readPublicExportPayloads(f.db, cut, events);
        assert.equal(events.length, count);
        assert.equal(payloads.size, count);
        for (const event of events)
          assert.equal(sha(String(payloads.get(event.eventId))), event.payloadSha256);
        assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
      } finally {
        f.sql.close();
      }
    });
  }
  test("concurrent appends cannot extend the captured cut or keep the collector running", async () => {
    const f = fixture(201);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const limits: number[] = [];
      const events = await collectPublicExportEvents(cut, async (after, limit) => {
        limits.push(limit);
        f.append(201 + limits.length);
        return f.readPage(after, limit);
      });
      assert.deepEqual(limits, [200, 1]);
      assert.equal(events.at(-1)?.seq, 201);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 201);
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: false });
    } finally {
      f.sql.close();
    }
  });
  test("a missing sequence cannot become a successful truncated archive", async () => {
    const f = fixture(201);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      f.sql.exec("DELETE FROM events WHERE seq=100");
      await refused(() => collectPublicExportEvents(cut, f.readPage));
    } finally {
      f.sql.close();
    }
  });
  for (const mutate of [
    "UPDATE event_content SET redacted_at='2026-09-22T00:00:00.000Z' WHERE event_id='E-1'",
    "DELETE FROM event_content WHERE event_id='E-1'",
    "UPDATE event_content SET payload_sha256='detached' WHERE event_id='E-1'",
    "UPDATE event_content SET payload_json='PRIVATE-CHANGED-BYTES-CANARY' WHERE event_id='E-1'",
    "UPDATE events SET problem_id='P-OTHER' WHERE id='E-1'",
    "UPDATE problems SET status='private-draft'",
    "UPDATE problems SET public_seq=0",
  ]) {
    test(`refuse unavailable payloads: ${mutate.split(" ").slice(0, 4).join(" ")}`, async () => {
      const f = fixture(2);
      try {
        const cut = await readPublicExportCut(f.db, "P-DEMO");
        const events = await collectPublicExportEvents(cut, f.readPage);
        f.sql.exec(mutate);
        await refused(() => readPublicExportPayloads(f.db, cut, events));
      } finally {
        f.sql.close();
      }
    });
  }
  test("revalidation catches withdrawal of a payload already read in an earlier chunk", async () => {
    const f = fixture(51);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      assert.equal((await readPublicExportPayloads(f.db, cut, events)).size, 51);
      f.sql.exec(
        "UPDATE event_content SET redacted_at='2026-09-22T00:00:00.000Z' WHERE event_id='E-1'",
      );
      await refused(() => revalidatePublicExportCut(f.db, cut));
    } finally {
      f.sql.close();
    }
  });
  for (const head of ["invalid", 9007199254740992]) {
    test(`a malformed live head cannot pass SQLite comparison coercion (${head})`, async () => {
      const f = fixture(1);
      try {
        const cut = await readPublicExportCut(f.db, "P-DEMO");
        const events = await collectPublicExportEvents(cut, f.readPage);
        f.sql.prepare("UPDATE problems SET public_seq=?").run(head);
        await refused(() => readPublicExportPayloads(f.db, cut, events));
        await refused(() => revalidatePublicExportCut(f.db, cut));
      } finally {
        f.sql.close();
      }
    });
  }
  test("unlisting wins after payload collection and remains sticky for this request", async () => {
    const f = fixture(1);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      f.sql.exec("UPDATE problems SET unlisted=1");
      assert.deepEqual(await revalidatePublicExportCut(f.db, cut), { unlisted: true });
      const unlistedCut = await readPublicExportCut(f.db, "P-DEMO");
      f.sql.exec("UPDATE problems SET unlisted=0");
      assert.deepEqual(await revalidatePublicExportCut(f.db, unlistedCut), { unlisted: true });
    } finally {
      f.sql.close();
    }
  });
  test("even an empty export must recheck current problem visibility", async () => {
    const f = fixture();
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      f.sql.exec("UPDATE problems SET status='private-draft'");
      await refused(() => revalidatePublicExportCut(f.db, cut));
    } finally {
      f.sql.close();
    }
  });
  for (const head of [-1, 1.5, 9007199254740992, null, "invalid", PUBLIC_EXPORT_MAX_EVENTS + 1]) {
    test(`stored head ${String(head)} is refused before archive traversal`, async () => {
      const f = fixture();
      try {
        f.sql.prepare("UPDATE problems SET public_seq=?").run(head);
        await refused(() => readPublicExportCut(f.db, "P-DEMO"));
        assert.equal(f.queries.length, 1);
      } finally {
        f.sql.close();
      }
    });
  }
  test("missing/private problems share a coarse refusal; invalid IDs never query", async () => {
    const f = fixture();
    try {
      await refused(() => readPublicExportCut(f.db, "../private"));
      assert.equal(f.queries.length, 0);
      await refused(() => readPublicExportCut(f.db, "P-MISSING"));
      f.sql.exec("UPDATE problems SET status='private-draft'");
      await refused(() => readPublicExportCut(f.db, "P-DEMO"));
    } finally {
      f.sql.close();
    }
  });
  test("oversized payloads and cumulative payload memory have explicit bounds", async () => {
    const f = fixture();
    try {
      f.append(1, JSON.stringify({ statement: "x".repeat(16384) }));
      let cut = await readPublicExportCut(f.db, "P-DEMO");
      let events = await collectPublicExportEvents(cut, f.readPage);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
      f.sql.exec("DELETE FROM event_content; DELETE FROM events; UPDATE problems SET public_seq=0");
      const payload = JSON.stringify({ statement: "x".repeat(16300) });
      for (let seq = 1; seq <= 520; seq++) f.append(seq, payload);
      cut = await readPublicExportCut(f.db, "P-DEMO");
      events = await collectPublicExportEvents(cut, f.readPage);
      await refused(() => readPublicExportPayloads(f.db, cut, events));
    } finally {
      f.sql.close();
    }
  });
  test("duplicate event identity and incorrect programmatic sequence inputs fail closed", async () => {
    const f = fixture(2);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const events = await collectPublicExportEvents(cut, f.readPage);
      await refused(() => collectPublicExportEvents(cut, async () => [events[0]!, events[0]!]));
      await refused(() => readPublicExportPayloads(f.db, cut, [events[1]!, events[0]!]));
    } finally {
      f.sql.close();
    }
  });
  test("cancellation stops work before the next database page", async () => {
    const f = fixture(201);
    try {
      const cut = await readPublicExportCut(f.db, "P-DEMO");
      const controller = new AbortController();
      let reads = 0;
      await assert.rejects(
        () =>
          collectPublicExportEvents(
            cut,
            async (after, limit) => {
              reads++;
              const result = await f.readPage(after, limit);
              controller.abort();
              return result;
            },
            controller.signal,
          ),
        (error: unknown) => error instanceof DOMException && error.name === "AbortError",
      );
      assert.equal(reads, 1);
    } finally {
      f.sql.close();
    }
  });
  test("served export uses payload/chain validation and revalidates before HTTP conditionals", () => {
    const source = readFileSync(
      new URL("../../src/ledger/event-tail-feeds.ts", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("readPublicExportCut(db, problemId)"));
    assert.ok(source.includes("collectPublicExportEvents("));
    assert.ok(source.includes("readPublicExportPayloads(db, cut, events, request.signal)"));
    assert.ok(source.includes("verifyProblemExportChain(ndjson)"));
    assert.ok(!source.includes('?? "{}"'));
    assert.ok(
      source.indexOf("await revalidatePublicExportCut(db, cut)") <
        source.indexOf('get("if-none-match")'),
    );
    assert.ok(source.includes('"cache-control": "private, no-store"'));
    assert.ok(source.includes("/events.ndjson?since=0&limit=200 instead."));
  });
});
