import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EvidenceRequest, ReviewRequest } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import {
  FORMAL_RECORD_MAX_BYTES,
  type FormalRecordDecoders,
  formalRecordPayload,
  readFormalRecordCandidates,
  readFormalRecordResource,
  readFormalRecords,
} from "../../src/ledger/formal-records.ts";
import { loadFormalizationFrictionMove } from "../../src/mega-commands/friction-moves-service.ts";

// Actual SQLite and digest checks. Reader tests use deliberately small decoder
// fixtures; the production friction-discovery test uses the real adapters.
// Neither is native Workerd or proof of the complete scientific evaluator.
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
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY,provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT,
      PRIMARY KEY(problem_id,target_ref,version));
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

test("formal evidence and verification history preserve source warnings without private screening receipts", async () => {
  const f = fixture();
  const receipt = JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  try {
    const artifactEvent = f.publish(2, artifact());
    const reviewEvent = f.publish(
      3,
      {
        target_claim_id: "C-1",
        target_version: 1,
        basis: "Checked the submitted source.",
        body_md: "An independent verification report.",
        verification: { reported: true },
      },
      { type: "review.created" },
    );
    const frictionEvent = f.publish(4, {
      ...artifact(),
      formal_artifact: undefined,
      kind: "formalization-friction",
      direction: "informs",
    });
    f.publish(5, artifact());
    for (const eventId of [artifactEvent, reviewEvent, frictionEvent])
      f.sqlite
        .query("INSERT INTO screening_publications VALUES(?,?)")
        .run(eventId, JSON.stringify(receipt));
    const page = await f.read();
    assert.deepEqual(
      page.records.map((record) => record.kind),
      ["formal-artifact", "verification-report", "formalization-friction", "formal-artifact"],
    );
    for (const record of page.records.slice(0, 3))
      assert.deepEqual(record.screening_notice, receipt.public_action);
    assert.equal(page.records[3]?.screening_notice, undefined);
    assert.ok(!JSON.stringify(page).includes(receipt.input_digest));
    assert.ok(!JSON.stringify(page).includes(receipt.model_version));
    f.sqlite
      .query("UPDATE screening_publications SET provenance_json=? WHERE event_id=?")
      .run(JSON.stringify({ ...receipt, private_detail: "PRIVATE_DETECTOR_CANARY" }), reviewEvent);
    await assert.rejects(f.read(), /PUBLIC_SCREENING_RECEIPT_UNAVAILABLE/);
    f.sqlite.query("INSERT INTO content_controls VALUES('P-DEMO','R-3',1,'hidden')").run();
    const hidden = await f.read();
    assert.ok(!hidden.records.some((record) => record.publication.object_id === "R-3"));
    assert.ok(hidden.omitted.includes("content_unavailable"));
  } finally {
    f.sqlite.close();
  }
});

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

function control(
  f: ReturnType<typeof fixture>,
  target: string,
  version = 1,
  visibility = "hidden",
  problem = "P-DEMO",
) {
  f.sqlite
    .query("INSERT INTO content_controls VALUES(?,?,?,?)")
    .run(problem, target, version, visibility);
}

for (const kind of ["formal-artifact", "formalization-friction", "verification-report"] as const) {
  for (const refKind of ["object", "version", "event"] as const) {
    test(`${kind}: ${refKind} hide and restore govern exact and historical reads`, async () => {
      const f = fixture();
      try {
        const { formal_artifact: _artifact, ...plain } = artifact();
        const payload =
          kind === "verification-report"
            ? {
                target_claim_id: "C-1",
                target_version: 1,
                verdict: "cannot-verify",
                basis: "The compilation failed.",
                verification: { kind: "formal-artifact" },
                body_md: "PRIVATE-HIDE-CANARY",
              }
            : kind === "formalization-friction"
              ? { ...plain, kind, direction: "informs", body_md: "PRIVATE-HIDE-CANARY" }
              : { ...artifact(), body_md: "PRIVATE-HIDE-CANARY" };
        const id = kind === "verification-report" ? "R-2" : "E-2";
        f.publish(2, payload, {
          type: kind === "verification-report" ? "review.created" : "evidence.created",
        });
        const before = await f.read(2);
        assert.equal(before.records[0]?.kind, kind);
        const ref = refKind === "event" ? "#2" : refKind === "version" ? `${id}@1` : id;
        control(f, ref);
        const hidden = await f.read(2);
        assert.deepEqual(hidden.records, []);
        assert.deepEqual(hidden.omitted, ["content_unavailable"]);
        assert.ok(!JSON.stringify(hidden).includes("PRIVATE-HIDE-CANARY"));
        const exact = await readFormalRecordResource(
          f.db,
          "P-DEMO",
          { through: 2, target: id },
          decoders,
        );
        assert.deepEqual(exact.records, []);
        assert.deepEqual(exact.omitted, ["content_unavailable"]);
        let decoded = 0;
        await readFormalRecords(f.db, "P-DEMO", 2, {
          evidence: () => {
            decoded++;
            return null;
          },
          review: () => {
            decoded++;
            return null;
          },
        });
        assert.equal(decoded, 0, "hidden bytes never cross the SQL-to-decoder boundary");
        control(f, ref, 2, "visible");
        assert.deepEqual(await f.read(2), before, "restore reuses the original immutable source");
      } finally {
        f.sqlite.close();
      }
    });
  }
}

test("a hidden problem cannot expose metadata or records through either read entry", async () => {
  const f = fixture();
  try {
    f.publish(2, artifact());
    const before = await f.read(2);
    control(f, "problem");
    await assert.rejects(f.read(2), /SNAPSHOT/);
    await assert.rejects(readFormalRecordResource(f.db, "P-DEMO", {}, decoders), /not-found/);
    await assert.rejects(
      readFormalRecordResource(f.db, "P-DEMO", { target: "E-2", through: 2 }, decoders),
      /not-found/,
    );
    control(f, "problem", 2, "visible");
    assert.deepEqual(await f.read(2), before);
  } finally {
    f.sqlite.close();
  }
});

test("a hide between discovery and the source batch withholds all formal bytes", async () => {
  const f = fixture();
  try {
    f.publish(2, artifact());
    const changed = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        control(f, "problem");
        return f.db.batch(statements);
      },
    } as D1Database;
    await assert.rejects(readFormalRecordResource(changed, "P-DEMO", {}, decoders), /SNAPSHOT/);
  } finally {
    f.sqlite.close();
  }
});

test("hidden admissions still advance pagination without replacing them with later records", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 9; i++) {
      f.publish(i, artifact());
      if (i <= 8) control(f, `E-${i}`);
    }
    const first = await f.read(9);
    assert.deepEqual(first.records, []);
    assert.equal(first.next_after, 8);
    assert.deepEqual(first.omitted, ["content_unavailable", "page_limit"]);
    const last = await f.read(9, 8);
    assert.deepEqual(
      last.records.map((r) => r.publication.object_id),
      ["E-9"],
    );
    assert.equal(last.next_after, null);
  } finally {
    f.sqlite.close();
  }
});

test("content controls are problem-scoped and exact-version-scoped", async () => {
  const f = fixture();
  try {
    f.publish(2, artifact());
    const before = await f.read(2);
    control(f, "E-2", 1, "hidden", "P-OTHER");
    control(f, "problem", 1, "hidden", "P-OTHER");
    control(f, "E-2@2");
    control(f, "#3");
    assert.deepEqual(await f.read(2), before);
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

test("formal discovery reaches later work without changing exhaustive admission pagination", async () => {
  const f = fixture();
  try {
    for (let seq = 1; seq <= 40; seq++)
      f.publish(
        seq,
        seq % 2 === 0
          ? { kind: "argument", body_md: "Ordinary evidence." }
          : { basis: "An ordinary review.", body_md: "No formal verification report." },
        seq % 2 === 0 ? {} : { type: "review.created" },
      );
    f.publish(41, artifact());
    f.publish(42, {
      ...artifact(),
      formal_artifact: undefined,
      kind: "formalization-friction",
      direction: "informs",
    });
    f.publish(
      43,
      {
        target_claim_id: "C-1",
        target_version: 1,
        basis: "Checked the supplied source.",
        body_md: "A verification report.",
        verification: { reported: true },
      },
      { type: "review.created" },
    );

    const history = await f.read();
    assert.deepEqual(history.records, []);
    assert.equal(history.next_after, 8, "public history retains every ordinary admission");
    const candidates = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders);
    assert.deepEqual(
      candidates.records.map((record) => [record.publication.seq, record.kind]),
      [
        [41, "formal-artifact"],
        [42, "formalization-friction"],
        [43, "verification-report"],
      ],
    );
    assert.equal(candidates.next_after, null);
    assert.equal(
      f.statements.length,
      4,
      "two SQL statements per reader, with no per-event queries",
    );
    assert.deepEqual(
      (await readFormalRecordResource(f.db, "P-DEMO", { target: "E-41" }, decoders)).records[0],
      candidates.records[0],
      "nomination never substitutes another decoder or weaker source record",
    );
  } finally {
    f.sqlite.close();
  }
});

test("friction discovery skips more than sixteen unrelated formal reports", async () => {
  const f = fixture();
  try {
    for (let seq = 1; seq <= 20; seq++) f.publish(seq, artifact());
    for (let seq = 21; seq <= 40; seq++)
      f.publish(
        seq,
        {
          target_claim_id: "C-1",
          target_version: 1,
          basis: "Checked an earlier source.",
          body_md: "A separate verification report.",
          verification: { reported: true },
        },
        { type: "review.created" },
      );
    f.publish(41, {
      ...artifact(),
      formal_artifact: undefined,
      kind: "formalization-friction",
      direction: "informs",
      body_md: "A new counterexample-scent report.",
    });
    const formal = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders);
    assert.equal(formal.records.length, 8);
    assert.equal(formal.next_after, 8);
    const friction = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders, 0, "friction");
    assert.deepEqual(
      friction.records.map((record) => record.publication.object_id),
      ["E-41"],
    );
    assert.equal(friction.records[0]?.kind, "formalization-friction");
    assert.equal(friction.next_after, null);
  } finally {
    f.sqlite.close();
  }
});

test("candidate pages retain the captured cut, source order and eight-record bound", async () => {
  const f = fixture();
  try {
    for (let seq = 1; seq <= 90; seq++)
      f.publish(seq, seq % 10 === 0 ? artifact() : { kind: "argument", body_md: "Other work." });
    const first = await readFormalRecordCandidates(f.db, "P-DEMO", 90, decoders);
    assert.deepEqual(
      first.records.map((record) => record.publication.seq),
      [10, 20, 30, 40, 50, 60, 70, 80],
    );
    assert.equal(first.next_after, 80);
    assert.deepEqual(first.omitted, ["page_limit"]);
    f.publish(95, artifact());
    assert.deepEqual(await readFormalRecordCandidates(f.db, "P-DEMO", 90, decoders), first);
    const tail = await readFormalRecordCandidates(f.db, "P-DEMO", 90, decoders, 80);
    assert.deepEqual(
      tail.records.map((record) => record.publication.seq),
      [90],
    );
    assert.equal(tail.next_after, null);
  } finally {
    f.sqlite.close();
  }
});

test("hidden ordinary and formal admissions are indistinguishable to candidate selection", async () => {
  const pages = [];
  for (const payload of [
    { kind: "argument", body_md: "PRIVATE-KIND-CANARY" },
    { ...artifact(), body_md: "PRIVATE-KIND-CANARY" },
  ]) {
    const f = fixture();
    try {
      f.publish(2, payload);
      control(f, "E-2");
      let decoded = 0;
      const refuse = () => {
        decoded++;
        throw new Error("Hidden content must not reach a decoder.");
      };
      const page = await readFormalRecordCandidates(
        f.db,
        "P-DEMO",
        100,
        { evidence: refuse, review: refuse },
        0,
        "friction",
      );
      assert.equal(decoded, 0);
      assert.deepEqual(page.records, []);
      assert.deepEqual(page.omitted, ["content_unavailable"]);
      assert.ok(!JSON.stringify(page).includes("PRIVATE-KIND-CANARY"));
      pages.push(page);
    } finally {
      f.sqlite.close();
    }
  }
  assert.deepEqual(
    pages[0],
    pages[1],
    "a hidden record's subtype must not select a different face",
  );
});

test("source-field nominations cannot mint a formal record from damaged bytes", async () => {
  const f = fixture();
  try {
    const id = f.publish(1, { kind: "argument", body_md: "Ordinary work." });
    f.sqlite
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(JSON.stringify(artifact()), id);
    let decoded = 0;
    const reject = () => {
      decoded++;
      throw new Error("Mismatched source must not reach a decoder.");
    };
    const page = await readFormalRecordCandidates(f.db, "P-DEMO", 100, {
      evidence: reject,
      review: reject,
    });
    assert.equal(decoded, 0);
    assert.deepEqual(page.records, []);
    assert.deepEqual(page.omitted, ["content_unavailable"]);
    f.sqlite.query("UPDATE event_content SET payload_json='{' WHERE event_id=?").run(id);
    const malformed = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders);
    assert.deepEqual(malformed.records, []);
    assert.deepEqual(malformed.omitted, ["content_unavailable"]);
  } finally {
    f.sqlite.close();
  }
});

test("an unnominated damaged record remains visible to the exhaustive integrity reader", async () => {
  const f = fixture();
  try {
    const id = f.publish(1, artifact());
    f.sqlite
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(JSON.stringify({ kind: "argument", body_md: "Changed without a matching digest." }), id);
    const selected = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders);
    assert.deepEqual(selected.records, []);
    const history = await f.read();
    assert.deepEqual(history.records, []);
    assert.deepEqual(history.omitted, ["content_unavailable"]);
  } finally {
    f.sqlite.close();
  }
});

test("candidate nomination still obeys scope and decoded record kind", async () => {
  const f = fixture();
  try {
    f.publish(1, { ...artifact(), kind: "formalization-friction" });
    f.publish(2, artifact(), { problem: "P-OTHER" });
    const friction = await readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders, 0, "friction");
    assert.deepEqual(friction.records, [], "an artifact is not a friction witness");
    f.sqlite.query("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'").run();
    await assert.rejects(readFormalRecordCandidates(f.db, "P-DEMO", 100, decoders), /SNAPSHOT/);
  } finally {
    f.sqlite.close();
  }
});

test("the production friction move finds a witness after unrelated evidence and formal work", async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      "CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT)",
    );
    const claim: ReviewQueueItem = {
      problem_id: "P-DEMO",
      claim_id: "C-1",
      version: 1,
      cursor: 100,
      kind: "lemma",
      statement: "Every denominator in the stated domain is nonzero.",
      falsifier: "A denominator is zero at a point in the stated domain.",
      disposition: "disputed",
      need: "resolve-dispute",
      best_recorded_tier: "none",
      direct_dependents: 1,
      dependents_capped: false,
      author_fellow_id: "F-origin",
      author_sponsor_id: "usr-origin",
      created_at: "2026-09-01T00:00:00.000Z",
      read_url: "/p/P-DEMO/claims/C-1@1.md?through=100",
    };
    f.publish(
      1,
      {
        claim_id: claim.claim_id,
        kind: claim.kind,
        statement: claim.statement,
        falsifier: claim.falsifier,
      },
      { type: "claim.created", kind: "claim", object: "C-1" },
    );
    for (let seq = 2; seq <= 20; seq++)
      f.publish(seq, { kind: "argument", body_md: "Earlier unrelated evidence." });
    for (let seq = 21; seq <= 40; seq++) f.publish(seq, artifact());
    f.publish(41, {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "formalization-friction",
      direction: "informs",
      mode: "exploratory",
      source: { kind: "model_memory" },
      body_md: JSON.stringify({
        format: "asimposium.formalization-friction.v1",
        blocker: "counterexample-scent",
        toolchain: "Lean local",
        blocked_obligation: "Show that the denominator is nonzero.",
        witness_seed: "Investigate the boundary at zero.",
        analysis: "The attempt appears to require a missing regularity condition.",
      }),
    });
    const result = await loadFormalizationFrictionMove(f.db, "P-DEMO", 100, [claim]);
    assert.ok(result.move);
    assert.equal(result.move.move, "add-refuter-from-friction");
    assert.deepEqual(result.move.refs, ["P-DEMO", "C-1@1", "E-41"]);
    assert.equal(
      (result.move.contract.request as { path: string }).path,
      "/v1/sessions/{id}/workshop",
    );
    assert.match(result.move?.selection_boundary ?? "", /not an exhaustive history/);
    assert.ok(!JSON.stringify(result.move).includes("missing regularity condition"));
    assert.equal(f.statements.length, 3, "candidate batch and one exact target-binding query");

    control(f, "E-41");
    const hidden = await loadFormalizationFrictionMove(f.db, "P-DEMO", 100, [claim]);
    assert.equal(hidden.move, null);
    assert.equal(hidden.degraded, true);
  } finally {
    f.sqlite.close();
  }
});
