import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { EvidenceRequest, ReviewRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  FORMAL_RECORD_MAX_BYTES,
  type FormalRecordDecoders,
  formalRecordPayload,
  readFormalRecordResource,
  readFormalRecords,
} from "../../src/ledger/formal-records.ts";

// Actual SQLite and digest checks. These deliberately small decoder fixtures
// are NOT proof of the production Zod adapter or scientific evaluator.
const decoders: FormalRecordDecoders = {
  evidence: (value) =>
    typeof value.body_md === "string" && value.source !== undefined
      ? (value as unknown as EvidenceRequest)
      : null,
  review: (value) =>
    typeof value.basis === "string" && value.verification !== undefined
      ? (value as unknown as ReviewRequest)
      : null,
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const artifact = (version = 1) => ({
  bears_on_kind: "claim",
  bears_on_id: "C-1",
  bears_on_version: version,
  kind: "certificate",
  direction: "supports",
  mode: "confirmatory",
  source: { kind: "model_memory" },
  body_md: "A reported formal work product, not a server compilation.",
  formal_artifact: {
    language: "lean",
    declaration: "example",
    source: "theorem example : True := True.intro",
    toolchain: "lean fixture",
    axiom_report: "Self-reported axiom listing",
  },
});
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,
      model_string_self_declared TEXT,harness TEXT,created_at TEXT,UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    INSERT INTO problems VALUES('P-DEMO',100,'active',0),('P-OTHER',100,'active',0);`);
  const statements: string[] = [];
  function prepare(sql: string) {
    return {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        this.args = args;
        return this;
      },
      async all() {
        statements.push(sql);
        return { results: sqlite.query(sql).all(...(this.args as never[])) };
      },
      async first() {
        statements.push(sql);
        return sqlite.query(sql).get(...(this.args as never[])) ?? null;
      },
    };
  }
  const db = {
    prepare,
    async batch(values: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const value of values) result.push(await value.all());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  function publish(
    seq: number,
    payload: object,
    options: {
      problem?: string;
      type?: string;
      kind?: string;
      version?: number;
      object?: string;
    } = {},
  ) {
    const problem = options.problem ?? "P-DEMO",
      id = `EV-${problem}-${seq}`;
    const json = JSON.stringify(payload),
      type = options.type ?? "evidence.created";
    sqlite
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        problem,
        seq,
        type,
        options.kind ?? (type === "review.created" ? "review" : "evidence"),
        options.object ?? (type === "review.created" ? `R-${seq}` : `E-${seq}`),
        options.version ?? 1,
        hash(json),
        "F-origin",
        "usr-origin",
        "S-origin",
        "declared-model",
        "declared-harness",
        "2026-09-01T00:00:00.000Z",
      );
    sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, hash(json), json);
    return id;
  }
  return {
    sqlite,
    db,
    statements,
    publish,
    read: (cursor = 100, after = 0) => readFormalRecords(db, "P-DEMO", cursor, decoders, after),
  };
}

test("formal records include exact artifact source and immutable attribution", async () => {
  const f = fixture();
  try {
    const id = f.publish(2, artifact(3));
    const page = await f.read();
    assert.equal(page.records.length, 1);
    const item = page.records[0];
    assert.ok(item);
    assert.equal(item.kind, "formal-artifact");
    assert.deepEqual(item.target, { claim_id: "C-1", version: 3 });
    assert.equal(item.publication.event_id, id);
    assert.equal(item.publication.fellow_id, "F-origin");
    assert.deepEqual(item.content, artifact(3));
    assert.equal(page.cursor, 100);
    assert.equal(page.next_after, null);
    assert.equal(f.statements.length, 2);
  } finally {
    f.sqlite.close();
  }
});
test("friction and verification reports are recorded work, not a computed scientific verdict", async () => {
  const f = fixture();
  try {
    const { formal_artifact: _artifact, ...plain } = artifact();
    f.publish(2, { ...plain, kind: "formalization-friction", direction: "informs" });
    f.publish(
      3,
      {
        target_claim_id: "C-1",
        target_version: 1,
        verdict: "cannot-verify",
        basis: "The toolchain failed to build.",
        verification: { kind: "formal-artifact", result: "cannot-verify" },
        body_md: "Observed failure.",
      },
      { type: "review.created" },
    );
    const page = await f.read();
    assert.deepEqual(
      page.records.map((record) => record.kind),
      ["formalization-friction", "verification-report"],
    );
    const secondRecord = page.records[1];
    assert.ok(secondRecord);
    assert.equal((secondRecord.content as ReviewRequest).verdict, "cannot-verify");
  } finally {
    f.sqlite.close();
  }
});
for (const damage of ["redacted", "deleted", "tampered", "digest", "oversized"]) {
  test(`withhold ${damage} content without inventing an empty baseline`, async () => {
    const f = fixture();
    try {
      const id = f.publish(2, artifact());
      if (damage === "redacted")
        f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
      if (damage === "deleted")
        f.sqlite.query("DELETE FROM event_content WHERE event_id=?").run(id);
      if (damage === "tampered")
        f.sqlite.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(id);
      if (damage === "digest")
        f.sqlite
          .query("UPDATE event_content SET payload_sha256=? WHERE event_id=?")
          .run("b".repeat(64), id);
      if (damage === "oversized")
        f.sqlite
          .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
          .run(" ".repeat(FORMAL_RECORD_MAX_BYTES + 1), id);
      const page = await f.read();
      assert.equal(page.records.length, 0);
      assert.ok(page.omitted.includes("content_unavailable"));
    } finally {
      f.sqlite.close();
    }
  });
}
test("hash is verified before decoding untrusted record content", async () => {
  const f = fixture();
  try {
    const id = f.publish(2, artifact());
    f.sqlite.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(id);
    let decoded = 0;
    const fail = () => {
      decoded++;
      throw new Error("must not decode");
    };
    await readFormalRecords(f.db, "P-DEMO", 100, { evidence: fail, review: fail });
    assert.equal(decoded, 0);
  } finally {
    f.sqlite.close();
  }
});
test("pagination advances through eight non-formal admissions", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 8; n++) f.publish(n, { kind: "argument", body_md: "ordinary evidence" });
    f.publish(9, artifact());
    const first = await f.read();
    assert.equal(first.records.length, 0);
    assert.equal(first.next_after, 8);
    assert.deepEqual(first.omitted, ["page_limit"]);
    const second = await f.read(100, 8);
    assert.equal(second.records[0]?.publication.seq, 9);
    assert.equal(second.next_after, null);
  } finally {
    f.sqlite.close();
  }
});
test("later appends do not change a captured snapshot or enter its continuation", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 9; n++) f.publish(n, artifact());
    const before = await f.read(9);
    f.publish(10, artifact());
    assert.deepEqual(await f.read(9), before);
    const tail = await f.read(9, 8);
    assert.equal(tail.records.length, 1);
    assert.equal(tail.records[0]?.publication.seq, 9);
  } finally {
    f.sqlite.close();
  }
});
test("historical snapshots still obey present-day content withdrawal", async () => {
  const f = fixture();
  try {
    const id = f.publish(2, artifact());
    assert.equal((await f.read(2)).records.length, 1);
    f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
    assert.equal((await f.read(2)).records.length, 0);
  } finally {
    f.sqlite.close();
  }
});
test("cross-problem, private and future data never become a formal pack", async () => {
  const f = fixture();
  try {
    f.publish(2, artifact(), { problem: "P-OTHER" });
    assert.equal((await f.read()).records.length, 0);
    await assert.rejects(f.read(101), /SNAPSHOT/);
    f.publish(2, artifact());
    f.sqlite.query("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'").run();
    await assert.rejects(f.read(), /SNAPSHOT/);
  } finally {
    f.sqlite.close();
  }
});
test("exact envelope and target mismatches cannot acquire a formal reading label", async () => {
  const f = fixture();
  try {
    f.publish(1, { ...artifact(), evidence_id: "E-wrong" });
    f.publish(2, artifact(), { version: 2 });
    f.publish(3, { ...artifact(), bears_on_id: "C-1\n" });
    f.publish(4, { ...artifact(), bears_on_version: 0 });
    f.publish(5, { ...artifact(), bears_on_kind: "hypothesis" });
    const result = await f.read();
    assert.equal(result.records.length, 0);
    assert.ok(result.omitted.includes("unsupported_record"));
  } finally {
    f.sqlite.close();
  }
});
test("UTF-8 byte bound is enforced, not merely character count", async () => {
  const text = JSON.stringify({ source: "𝒙".repeat(FORMAL_RECORD_MAX_BYTES / 4) });
  assert.ok(text.length < FORMAL_RECORD_MAX_BYTES);
  assert.equal(await formalRecordPayload(text, hash(text)), null);
  assert.equal(await formalRecordPayload("[]", hash("[]")), null);
  assert.equal(await formalRecordPayload("broken", hash("broken")), null);
});
test("invalid cursor input is refused before any database read", async () => {
  const f = fixture();
  try {
    for (const [cursor, after] of [
      [-1, 0],
      [2, 3],
      [1.5, 0],
      [NaN, 0],
      [2, -1],
    ])
      await assert.rejects(f.read(cursor, after), /QUERY/);
    assert.equal(f.statements.length, 0);
  } finally {
    f.sqlite.close();
  }
});

test("exact full reads find large artifacts beyond the bounded pack admissions", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 20; i++)
      f.publish(i, { kind: "argument", body_md: "Ordinary ledger work." });
    const large = {
      ...artifact(),
      body_md: "A".repeat(30000),
      formal_artifact: {
        ...artifact().formal_artifact,
        source: "-- original source\n" + "x".repeat(40000),
      },
    };
    f.publish(21, large);
    const exact = await readFormalRecordResource(f.db, "P-DEMO", { target: "E-21" }, decoders);
    assert.equal(exact.records.length, 1);
    assert.deepEqual(exact.records[0]?.content, large);
    assert.equal(exact.target, "E-21");
    assert.equal(exact.cursor, 100);
    assert.equal(exact.next_after, null);
  } finally {
    f.sqlite.close();
  }
});
test("an unlisted full read carries authoritative private-cache metadata", async () => {
  const f = fixture();
  try {
    f.publish(1, artifact());
    f.sqlite.query("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'").run();
    assert.equal(
      (await readFormalRecordResource(f.db, "P-DEMO", { target: "E-1" }, decoders)).unlisted,
      true,
    );
  } finally {
    f.sqlite.close();
  }
});
test("unlisting between the initial head and snapshot read prevents shared caching", async () => {
  const f = fixture();
  try {
    f.publish(1, artifact());
    const changed = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        f.sqlite.query("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'").run();
        return f.db.batch(statements);
      },
    } as D1Database;
    const resource = await readFormalRecordResource(changed, "P-DEMO", {}, decoders);
    assert.equal(resource.unlisted, true);
  } finally {
    f.sqlite.close();
  }
});
test("missing and nonformal exact targets are not found, not a misleading formal result", async () => {
  const f = fixture();
  try {
    f.publish(1, { kind: "argument", body_md: "Ordinary work." });
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-1" }, decoders),
      /not-found/,
    );
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-99" }, decoders),
      /not-found/,
    );
    f.sqlite.query("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'").run();
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-1" }, decoders),
      /not-found/,
    );
  } finally {
    f.sqlite.close();
  }
});
test("ambiguous immutable object identity fails instead of choosing an arbitrary version", async () => {
  const f = fixture();
  try {
    f.publish(1, artifact(), { object: "E-1" });
    f.publish(2, artifact(), { object: "E-1" });
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-1" }, decoders),
      /unavailable/,
    );
  } finally {
    f.sqlite.close();
  }
});
test("exact reads cannot substitute a future or cross-problem record", async () => {
  const f = fixture();
  try {
    f.publish(9, artifact(), { object: "E-9" });
    f.publish(3, artifact(), { problem: "P-OTHER", object: "E-3" });
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { through: 8, target: "E-9" }, decoders),
      /not-found/,
    );
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-3" }, decoders),
      /not-found/,
    );
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { through: 101, target: "E-9" }, decoders),
      /query/,
    );
  } finally {
    f.sqlite.close();
  }
});
test("withdrawn full reads retain an omission rather than serving previously readable bytes", async () => {
  const f = fixture();
  try {
    const id = f.publish(1, artifact());
    f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
    const result = await readFormalRecordResource(
      f.db,
      "P-DEMO",
      { through: 1, target: "E-1" },
      decoders,
    );
    assert.equal(result.records.length, 0);
    assert.deepEqual(result.omitted, ["content_unavailable"]);
    assert.equal(result.target, "E-1");
  } finally {
    f.sqlite.close();
  }
});
test("target and after are exclusive even when after is zero", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-1", after: 0 }, decoders),
      /query/,
    );
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-1\n" }, decoders),
      /query/,
    );
    assert.equal(f.statements.length, 0);
  } finally {
    f.sqlite.close();
  }
});
