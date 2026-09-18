import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import {
  HYPOTHESIS_CONTENT_BYTES,
  type HypothesisDecoders,
  readHypotheses,
} from "../../src/ledger/hypotheses-read";

// Tests exercise the real SQL and content commitments. The production Zod
// decoder is tested separately; this fixture decoder admits only our objects.
const decoders: HypothesisDecoders = {
  publication(value) {
    const v = value as any;
    return v && typeof v.route === "string" && typeof v.body_md === "string" ? v : null;
  },
  kill(value) {
    const v = value as any;
    return v && typeof v.hypothesis_id === "string" && typeof v.reason === "string" ? v : null;
  },
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, created_at TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE hypotheses(hypothesis_id TEXT, route TEXT, status TEXT);`);
  const prepare = (query: string) => ({
    bind: (...args: any[]) => ({
      all: async () => ({ results: sql.prepare(query).all(...args), success: true, meta: {} }),
    }),
  });
  const db = {
    prepare,
    batch: async (statements: any[]) => {
      sql.exec("BEGIN");
      try {
        const rows = [];
        for (const s of statements) rows.push(await s.all());
        sql.exec("COMMIT");
        return rows;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  function event(
    seq: number,
    id = `H-${seq}`,
    type = "hypothesis.created",
    extra: Record<string, unknown> = {},
    pid = "P-DEMO",
  ) {
    const content =
      type === "hypothesis.created"
        ? {
            route: `Route ${id}`,
            mechanism: "A distinct construction",
            falsifier: "A finite counterexample",
            expected_evidence: null,
            discriminating_predictions: ["Different boundary result"],
            origin: "proposed",
            body_md: `Work product for ${id}`,
            ...extra,
          }
        : {
            hypothesis_id: id,
            killed_by_evidence_id: "E-1",
            reason: "The recorded falsifier fired",
            ...extra,
          };
    const text = JSON.stringify(content),
      hash = sha(text),
      eid = `${pid}-${seq}`;
    sql
      .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        eid,
        pid,
        seq,
        type,
        "hypothesis",
        id,
        1,
        "2026-09-01T00:00:00.000Z",
        hash,
        "F-ORIGINAL",
        "SP-ORIGINAL",
        "S-ORIGINAL",
        "declared-model",
        "declared-harness",
      );
    sql.prepare("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eid, hash, text);
    sql.prepare("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq, pid);
    return eid;
  }
  return {
    sql,
    db,
    event,
    read: (query = {}, selection = {}) => readHypotheses(db, "P-DEMO", query, decoders, selection),
  };
}

test("public reader returns committed hypotheses and full original attribution without projection authority", async () => {
  const f = fixture();
  try {
    f.event(1);
    f.sql.exec("INSERT INTO hypotheses VALUES('H-1','Projection poison','killed')");
    const r = await f.read();
    assert.ok(r);
    assert.equal(r.face.hypotheses[0]?.content?.route, "Route H-1");
    assert.equal(r.face.hypotheses[0]?.status, "active");
    assert.equal(r.face.hypotheses[0]?.publication.sponsor_id, "SP-ORIGINAL");
    assert.equal(r.face.hypotheses[0]?.publication.session_id, "S-ORIGINAL");
    assert.equal(r.face.hypotheses[0]?.publication.model_self_declared, "declared-model");
  } finally {
    f.sql.close();
  }
});
test("a kill changes lifecycle only at its captured cursor; prior publication remains readable", async () => {
  const f = fixture();
  try {
    f.event(1, "H-1");
    f.event(2, "H-1", "hypothesis.killed");
    assert.equal((await f.read({ through: 1 }))?.face.hypotheses[0]?.status, "active");
    const item = (await f.read())?.face.hypotheses[0];
    assert.equal(item?.status, "killed");
    assert.equal(item?.content?.route, "Route H-1");
    assert.equal(item?.kill?.killed_by_evidence_id, "E-1");
    assert.equal(item?.last_event.seq, 2);
  } finally {
    f.sql.close();
  }
});
for (const target of ["creation", "kill"] as const) {
  for (const damage of ["redact", "tamper", "hash", "missing", "oversize"] as const) {
    test(`${damage} ${target} bytes are withheld without reviving a killed route`, async () => {
      const f = fixture();
      try {
        const c = f.event(1, "H-1"),
          k = f.event(2, "H-1", "hypothesis.killed");
        const id = target === "creation" ? c : k;
        if (damage === "redact")
          f.sql.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
        if (damage === "tamper")
          f.sql.prepare("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(id);
        if (damage === "hash")
          f.sql
            .prepare("UPDATE event_content SET payload_sha256=? WHERE event_id=?")
            .run("f".repeat(64), id);
        if (damage === "missing")
          f.sql.prepare("DELETE FROM event_content WHERE event_id=?").run(id);
        if (damage === "oversize") {
          const raw = JSON.stringify({
            route: "Too large",
            body_md: "x".repeat(HYPOTHESIS_CONTENT_BYTES),
          });
          f.sql
            .prepare("UPDATE event_content SET payload_json=?,payload_sha256=? WHERE event_id=?")
            .run(raw, sha(raw), id);
          f.sql.prepare("UPDATE events SET payload_sha256=? WHERE id=?").run(sha(raw), id);
        }
        const r = await f.read();
        assert.ok(r);
        const item = r.face.hypotheses[0];
        assert.equal(item?.status, "killed");
        assert.ok(r.face.omitted.includes("content_unavailable"));
        assert.equal(target === "creation" ? item?.content : item?.kill, null);
        if (target === "creation")
          assert.equal((await f.read({ through: 1 }))?.face.hypotheses[0]?.content, null);
      } finally {
        f.sql.close();
      }
    });
  }
}
test("private and missing problems are indistinguishable; exact unlisted reads carry a flag", async () => {
  const f = fixture();
  try {
    f.event(1);
    f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
    assert.equal(await f.read(), null);
    assert.equal(await readHypotheses(f.db, "P-MISSING", {}, decoders), null);
    f.sql.exec("UPDATE problems SET status='active',unlisted=1 WHERE id='P-DEMO'");
    assert.equal((await f.read())?.unlisted, true);
  } finally {
    f.sql.close();
  }
});
test("a different problem and events beyond the public head cannot enter this face", async () => {
  const f = fixture();
  try {
    f.event(1);
    f.event(2);
    f.event(1, "H-90", "hypothesis.created", {}, "P-OTHER");
    f.sql.exec("UPDATE problems SET public_seq=1 WHERE id='P-DEMO'");
    assert.deepEqual(
      (await f.read())?.face.hypotheses.map((h) => h.hypothesis_id),
      ["H-1"],
    );
  } finally {
    f.sql.close();
  }
});
test("pagination advances across withdrawn bodies and pins continuation to the original cut", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 11; i++) f.event(i);
    f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='P-DEMO-8'");
    const first = await f.read();
    assert.ok(first);
    assert.equal(first.face.next_after, 8);
    f.event(12);
    const second = await f.read({ after: first.face.next_after!, through: first.face.cursor });
    assert.ok(second);
    assert.deepEqual(
      second.face.hypotheses.map((h) => h.hypothesis_id),
      ["H-9", "H-10", "H-11"],
    );
    assert.equal(second.face.next_after, null);
  } finally {
    f.sql.close();
  }
});
test("live selection scans past killed routes but retains unknown transitions and unreadable active entries", async () => {
  const f = fixture();
  try {
    f.event(1, "H-1");
    f.event(2, "H-1", "hypothesis.killed");
    f.event(3, "H-2");
    f.event(4, "H-3");
    f.event(5, "H-3", "hypothesis.deferred");
    const r = await f.read({}, { liveOnly: true, limit: 3 });
    assert.ok(r);
    assert.deepEqual(
      r.face.hypotheses.map((h) => [h.hypothesis_id, h.status]),
      [
        ["H-2", "active"],
        ["H-3", "unavailable"],
      ],
    );
    assert.ok(r.face.omitted.includes("lifecycle_unavailable"));
  } finally {
    f.sql.close();
  }
});
test("duplicate creation, mismatched kill target and unsupported version do not become live hypotheses", async () => {
  const f = fixture();
  try {
    f.event(1, "H-1");
    f.event(2, "H-1");
    f.event(3, "H-2");
    f.event(4, "H-2", "hypothesis.killed", { hypothesis_id: "H-999" });
    f.event(5, "H-3");
    f.sql.exec("UPDATE events SET object_version=2 WHERE id='P-DEMO-5'");
    const r = await f.read();
    assert.ok(r);
    assert.deepEqual(
      r.face.hypotheses.map((h) => h.status),
      ["unavailable", "unavailable", "unavailable"],
    );
  } finally {
    f.sql.close();
  }
});
for (const query of [
  { after: -1 },
  { after: 1.2 },
  { through: NaN },
  { through: Number.MAX_SAFE_INTEGER + 1 },
  { after: 2, through: 1 },
]) {
  test(`invalid cursor fails before database access: ${JSON.stringify(query)}`, async () => {
    await assert.rejects(
      readHypotheses(
        {
          batch() {
            throw new Error("DB touched");
          },
        } as any,
        "P-DEMO",
        query,
        decoders,
      ),
      /CURSOR_INVALID/,
    );
  });
}
test("a future cursor is not silently clamped", async () => {
  const f = fixture();
  try {
    f.event(1);
    await assert.rejects(f.read({ through: 2 }), /CURSOR_INVALID/);
  } finally {
    f.sql.close();
  }
});
test("database failure is not an empty list", async () => {
  const db = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => {
      throw new Error("database unavailable");
    },
  } as any;
  await assert.rejects(readHypotheses(db, "P-DEMO", {}, decoders));
});
