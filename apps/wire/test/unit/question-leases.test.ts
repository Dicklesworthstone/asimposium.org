import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { scientificContentGuards } from "../../src/ledger/scientific-checks.ts";
import {
  findQuestionLeaseSource,
  QUESTION_LEASE_STATE_SQL,
} from "../../src/sessions/question-leases.ts";

const open: Database[] = [];
afterEach(() => {
  for (const sql of open.splice(0)) sql.close();
});

function fixture() {
  const sql = new Database(":memory:", { strict: true });
  open.push(sql);
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE questions(question_id TEXT, problem_id TEXT, seq INTEGER, status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_id TEXT,
      object_kind TEXT, object_version INTEGER, type TEXT, actor_fellow_id TEXT, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT,
      redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE scientific_withdrawals(source_event_id TEXT);
    INSERT INTO problems VALUES ('P-Q', 'active', 1), ('P-OTHER', 'active', 1);
    INSERT INTO questions VALUES ('Q-test', 'P-Q', 1, 'open');
  `);
  const append = (seq: number, type: string, body: Record<string, unknown>) => {
    const raw = JSON.stringify({ question_id: "Q-test", ...body });
    const digest = createHash("sha256").update(raw).digest("hex");
    const id = `E-${seq}`;
    sql
      .query(
        "INSERT INTO events VALUES (?, 'P-Q', ?, 'Q-test', 'question', 1, ?, 'fellow-holder', ?)",
      )
      .run(id, seq, type, digest);
    sql.query("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, digest, raw);
    sql.query("UPDATE problems SET public_seq = ? WHERE id = 'P-Q'").run(seq);
    return id;
  };
  append(1, "question.asked", {
    problem_id: "P-Q",
    body_md: "Which finite boundary case decides this conjecture?",
    target_refs: [],
    blocking: null,
  });
  function prepare(query: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...bound: (string | number | null)[]) {
        values = bound;
        return this;
      },
      async first() {
        return sql.query(query).get(...values);
      },
      execute() {
        return { success: true, results: sql.query(query).all(...values), meta: {} };
      },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return sql.transaction(() => statements.map((statement) => statement.execute()))();
    },
  } as unknown as D1Database;
  const state = async () => {
    const source = await findQuestionLeaseSource(db, "P-Q", "Q-test");
    if (source === null) return null;
    return (
      (
        sql
          .query(`SELECT 1 AS allowed WHERE 1 ${QUESTION_LEASE_STATE_SQL}`)
          .get(source.latestEventId, "P-Q", "Q-test") as { allowed: number } | null
      )?.allowed ?? 0
    );
  };
  return { sql, db, append, state };
}

test("question lease admission pins verified creation and lifecycle sources, separate from live lease events", async () => {
  const f = fixture();
  const initial = await findQuestionLeaseSource(f.db, "P-Q", "Q-test");
  expect(initial).toMatchObject({
    questionId: "Q-test",
    canonicalRef: "Q-1",
    status: "open",
    latestEventId: "E-1",
  });
  expect(await f.state()).toBe(1);
  f.append(2, "question.leased", {
    leased_by: "fellow-holder",
    leased_until: "2027-01-01T00:00:00.000Z",
    objective: "Check the boundary",
    deliverable: "A scoped resolution",
  });
  f.sql.exec("UPDATE questions SET status = 'leased'");
  f.append(3, "lease.released", { lease_id: "L-operational" });
  const leased = await findQuestionLeaseSource(f.db, "P-Q", "Q-test");
  expect(leased).toMatchObject({ status: "leased", latestEventId: "E-2" });
  expect(leased?.sources.map((source) => source.eventId)).toEqual(["E-1", "E-2"]);
  expect(await f.state()).toBe(1);
  expect(
    f.sql
      .query(`SELECT 1 WHERE 1 ${QUESTION_LEASE_STATE_SQL}`)
      .get(initial?.latestEventId ?? "", "P-Q", "Q-test"),
  ).toBeNull();
});

for (const [type, status, payload] of [
  ["question.answered", "resolved", { resolved_by_object: "C-1@1" }],
  [
    "question.withdrawn",
    "withdrawn",
    { reason: "This question no longer describes the obstacle." },
  ],
] as const) {
  test(`a verified ${status} question cannot acquire a generic or dedicated reservation`, async () => {
    const f = fixture();
    f.append(2, type, payload);
    f.sql.query("UPDATE questions SET status = ?").run(status);
    expect(await findQuestionLeaseSource(f.db, "P-Q", "Q-test")).toMatchObject({ status });
    expect(await f.state()).toBe(0);
  });
}

for (const ref of ["problem", "P-Q", "Q-test", "Q-test@1", "#1"]) {
  test(`current ${ref} visibility overrides retained question projection state`, async () => {
    const f = fixture();
    f.sql.query("INSERT INTO content_controls VALUES ('P-Q', ?, 'hidden', 1)").run(ref);
    expect(await findQuestionLeaseSource(f.db, "P-Q", "Q-test")).toBeNull();
    f.sql.query("INSERT INTO content_controls VALUES ('P-Q', ?, 'visible', 2)").run(ref);
    expect(await f.state()).toBe(1);
  });
}

for (const [label, mutation] of [
  [
    "corrupt source bytes",
    "UPDATE event_content SET payload_json = replace(payload_json, 'finite', 'forged')",
  ],
  ["redacted source", "UPDATE event_content SET redacted_at = '2026-01-01T00:00:00.000Z'"],
  ["unpublished source", "UPDATE problems SET public_seq = 0 WHERE id = 'P-Q'"],
  ["private problem", "UPDATE problems SET status = 'private-draft' WHERE id = 'P-Q'"],
  ["cross-problem source", "UPDATE events SET problem_id = 'P-OTHER'"],
  ["forged source sequence", "UPDATE questions SET seq = 2"],
  ["forged lifecycle projection", "UPDATE questions SET status = 'leased'"],
] as const) {
  test(`${label} cannot become a lease target`, async () => {
    const f = fixture();
    f.sql.exec(mutation);
    expect(await findQuestionLeaseSource(f.db, "P-Q", "Q-test")).toBeNull();
  });
}

test("latest lease source must bind its holder to immutable attribution", async () => {
  const f = fixture();
  f.append(2, "question.leased", {
    leased_by: "someone-else",
    leased_until: "2027-01-01T00:00:00.000Z",
    objective: "Check the boundary",
    deliverable: "A scoped resolution",
  });
  f.sql.exec("UPDATE questions SET status = 'leased'");
  expect(await findQuestionLeaseSource(f.db, "P-Q", "Q-test")).toBeNull();
});

test("exact source-byte and visibility guards abort a transaction after admission", async () => {
  for (const mutation of [
    "UPDATE event_content SET payload_json = replace(payload_json, 'finite', 'forged')",
    "INSERT INTO content_controls VALUES ('P-Q', '#1', 'hidden', 1)",
  ]) {
    const f = fixture();
    const source = await findQuestionLeaseSource(f.db, "P-Q", "Q-test");
    expect(source).not.toBeNull();
    f.sql.exec("CREATE TABLE mutations(value TEXT)");
    f.sql.exec(mutation);
    await expect(
      f.db.batch([
        f.db.prepare("INSERT INTO mutations VALUES ('must-roll-back')"),
        ...scientificContentGuards(f.db, source?.sources ?? []),
      ]),
    ).rejects.toThrow("SCIENTIFIC_REFERENCE_CHANGED");
    expect(f.sql.query("SELECT * FROM mutations").all()).toEqual([]);
  }
});
