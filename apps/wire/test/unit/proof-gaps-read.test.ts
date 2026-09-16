import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { GapFileRequest, GapTransitionRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type ProofGapDecoders,
  ProofGapReadError,
  readProofGaps,
} from "../../src/ledger/proof-gaps-read.ts";

const date = "2026-09-01T00:00:00.000Z";
// Query/hash/history tests supply known write-schema fixtures. The production
// adapter uses the actual Zod write schemas; these callbacks do not test Zod.
const decoders: ProofGapDecoders = {
  filed: (value) => value as GapFileRequest,
  settled: (value) => value as GapTransitionRequest,
};
const payload = {
  target_claim_id: "C-1",
  target_version: 1,
  obligation: "Establish the missing uniform estimate.",
  closes_what: "The convergence step.",
};
async function hash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,created_at TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE leases(problem_id TEXT,object_id TEXT,object_ref TEXT,status TEXT,leased_until TEXT);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);`);
  let beforeBatch: (() => void) | undefined;
  const statements: string[] = [];
  const db = {
    prepare(text: string) {
      statements.push(text);
      return {
        bind(...args: (string | number | null)[]) {
          return {
            async first() {
              return sql.query(text).get(...args) ?? null;
            },
            async all() {
              return { results: sql.query(text).all(...args) };
            },
          };
        },
      };
    },
    async batch(queries: { all(): Promise<unknown> }[]) {
      beforeBatch?.();
      beforeBatch = undefined;
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const q of queries) results.push(await q.all());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  async function add(
    seq: number,
    type = "gap.filed",
    id = `G-${seq}`,
    body: unknown = payload,
    problem = "P-DEMO",
    publish = true,
  ) {
    const text = JSON.stringify(body),
      digest = await hash(text),
      event = `${problem}-${seq}`;
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event,
        problem,
        seq,
        type,
        "gap",
        id,
        1,
        digest,
        date,
        "F-author",
        "usr-original",
        "S-source",
        "declared-model",
        "declared-harness",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(event, digest, text);
    if (publish)
      sql
        .query("UPDATE problems SET public_seq = MAX(public_seq,?) WHERE id = ?")
        .run(seq, problem);
    return event;
  }
  const read = (query = {}, options?: string, decode = decoders) =>
    readProofGaps(db, "P-DEMO", query, decode, options);
  return {
    sql,
    db,
    add,
    read,
    statements,
    beforeBatch(fn: () => void) {
      beforeBatch = fn;
    },
    close() {
      sql.close();
    },
  };
}

test("gap records come from hashed event content and original attribution without a projection table", async () => {
  const f = fixture();
  try {
    await f.add(2);
    const result = await f.read();
    assert.equal(result.face.gaps[0]?.status, "open");
    assert.deepEqual(result.face.gaps[0]?.content, payload);
    assert.equal(result.face.gaps[0]?.filing.sponsor_id, "usr-original");
    assert.ok(f.statements.every((s) => !s.includes("proof_gaps")));
  } finally {
    f.close();
  }
});
test("historical reads keep the open gap before its recorded settlement", async () => {
  const f = fixture();
  try {
    await f.add(2);
    await f.add(4, "gap.closed-by", "G-2", {
      gap_id: "G-2",
      outcome: "closed-by",
      closed_by: "C-8@2",
    });
    assert.equal((await f.read({ through: 2 })).face.gaps[0]?.status, "open");
    const current = (await f.read()).face.gaps[0];
    assert.equal(current?.status, "closed-by");
    assert.equal(current?.closed_by, "C-8@2");
  } finally {
    f.close();
  }
});
test("withdrawn settlement content never reopens a gap or republishes its closure reference", async () => {
  const f = fixture();
  try {
    await f.add(2);
    const id = await f.add(3, "gap.closed-by", "G-2", {
      gap_id: "G-2",
      outcome: "closed-by",
      closed_by: "E-7",
    });
    f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id=?").run(date, id);
    const result = await f.read();
    assert.equal(result.face.gaps[0]?.status, "closed-by");
    assert.equal(result.face.gaps[0]?.closed_by, null);
    assert.ok(result.face.omitted.includes("content_unavailable"));
    assert.equal((await f.read({}, date)).face.gaps.length, 0);
  } finally {
    f.close();
  }
});
for (const mutation of ["altered", "redacted", "missing", "oversized", "digest-splice"]) {
  test(`filing ${mutation} content is withheld before the decoder`, async () => {
    const f = fixture();
    try {
      const id = await f.add(2);
      let calls = 0;
      if (mutation === "missing") f.sql.query("DELETE FROM event_content WHERE event_id=?").run(id);
      else if (mutation === "redacted")
        f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id=?").run(date, id);
      else if (mutation === "digest-splice")
        f.sql
          .query("UPDATE event_content SET payload_sha256=? WHERE event_id=?")
          .run("f".repeat(64), id);
      else
        f.sql
          .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
          .run(mutation === "oversized" ? "x".repeat(17000) : "{}", id);
      const result = await f.read({}, undefined, {
        ...decoders,
        filed(v) {
          calls++;
          return v as GapFileRequest;
        },
      });
      assert.equal(calls, 0);
      assert.equal(result.face.gaps[0]?.content, null);
      assert.ok(result.face.omitted.includes("content_unavailable"));
    } finally {
      f.close();
    }
  });
}
test("schema-invalid committed filing is unavailable rather than a fabricated empty obligation", async () => {
  const f = fixture();
  try {
    await f.add(2);
    const result = await f.read({}, undefined, { ...decoders, filed: () => null });
    assert.equal(result.face.gaps[0]?.content, null);
    assert.deepEqual(result.face.omitted, ["content_unavailable"]);
  } finally {
    f.close();
  }
});
for (const type of ["gap.reopened", "gap.reduced-to", "gap.partial", "gap.filed"]) {
  test(`unsupported or duplicate lifecycle ${type} is not interpreted as open`, async () => {
    const f = fixture();
    try {
      await f.add(2);
      await f.add(3, type, "G-2", payload);
      const result = await f.read();
      assert.equal(result.face.gaps[0]?.status, "unavailable");
      assert.ok(result.face.omitted.includes("history_unavailable"));
    } finally {
      f.close();
    }
  });
}
test("a mismatched terminal payload cannot name a different gap or outcome", async () => {
  const f = fixture();
  try {
    await f.add(2);
    await f.add(3, "gap.closed-by", "G-2", { gap_id: "G-9", outcome: "withdrawn" });
    assert.equal((await f.read()).face.gaps[0]?.status, "unavailable");
  } finally {
    f.close();
  }
});
test("multiple settlements are explicitly ambiguous", async () => {
  const f = fixture();
  try {
    await f.add(2);
    for (const n of [3, 4])
      await f.add(n, "gap.withdrawn", "G-2", {
        gap_id: "G-2",
        outcome: "withdrawn",
        closed_by: null,
      });
    assert.equal((await f.read()).face.gaps[0]?.status, "unavailable");
  } finally {
    f.close();
  }
});
test("pagination advances over withheld records and keeps the original cursor during appends", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 10; n++) await f.add(n);
    f.sql.exec("UPDATE event_content SET redacted_at='withdrawn' WHERE event_id='P-DEMO-8'");
    const first = await f.read();
    assert.equal(first.face.next_after, 8);
    await f.add(11);
    const next = await f.read({ through: first.face.cursor, after: first.face.next_after });
    assert.deepEqual(
      next.face.gaps.map((g) => g.gap_id),
      ["G-9", "G-10"],
    );
    assert.equal(next.face.next_after, null);
  } finally {
    f.close();
  }
});
test("an exact gap target is reachable without walking earlier pages", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 12; n++) await f.add(n);
    const result = await f.read({ target: "G-12", through: 12 });
    assert.deepEqual(
      result.face.gaps.map((g) => g.gap_id),
      ["G-12"],
    );
    assert.equal(result.face.next_after, null);
  } finally {
    f.close();
  }
});
test("private problems are refused while direct unlisted reads are marked private", async () => {
  const f = fixture();
  try {
    await f.add(2);
    f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
    await assert.rejects(
      f.read(),
      (e: unknown) => e instanceof ProofGapReadError && e.code === "not-found",
    );
    f.sql.exec("UPDATE problems SET status='active',unlisted=1 WHERE id='P-DEMO'");
    assert.equal((await f.read()).unlisted, true);
  } finally {
    f.close();
  }
});
test("visibility is rechecked with content, not only before the read transaction", async () => {
  const f = fixture();
  try {
    await f.add(2);
    f.beforeBatch(() => f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'"));
    await assert.rejects(f.read(), ProofGapReadError);
  } finally {
    f.close();
  }
});
test("cross-problem and unpublished events never enter this snapshot", async () => {
  const f = fixture();
  try {
    await f.add(1);
    await f.add(2, "gap.filed", "G-2", payload, "P-OTHER");
    await f.add(9, "gap.filed", "G-9", payload, "P-DEMO", false);
    assert.deepEqual(
      (await f.read()).face.gaps.map((g) => g.gap_id),
      ["G-1"],
    );
  } finally {
    f.close();
  }
});
test("future and incoherent cursors are refused rather than clamped", async () => {
  const f = fixture();
  try {
    await f.add(2);
    for (const query of [
      { through: 3 },
      { after: 3 },
      { through: -1 },
      { after: 1.5 },
      { target: "G-2", after: 0 },
    ])
      await assert.rejects(f.read(query), ProofGapReadError);
  } finally {
    f.close();
  }
});
test("unowned selection filters settled history and active leases before its page bound", async () => {
  const f = fixture();
  try {
    for (let n = 1; n < 40; n += 2) {
      await f.add(n);
      await f.add(n + 1, "gap.withdrawn", `G-${n}`, {
        gap_id: `G-${n}`,
        outcome: "withdrawn",
        closed_by: null,
      });
    }
    await f.add(41);
    await f.add(42);
    await f.add(43);
    f.sql
      .query("INSERT INTO leases VALUES(?,?,?,?,?)")
      .run("P-DEMO", "G-41", "G-41", "active", "2026-10-01T00:00:00.000Z");
    f.sql
      .query("INSERT INTO leases VALUES(?,?,?,?,?)")
      .run("P-DEMO", "G-42", "G-42", "active", date);
    assert.deepEqual(
      (await f.read({}, date)).face.gaps.map((g) => g.gap_id),
      ["G-42", "G-43"],
    );
    assert.equal((await f.read({ through: 1 }, date)).face.gaps[0]?.status, "open");
  } finally {
    f.close();
  }
});
test("released and cross-problem leases do not hide an unowned gap", async () => {
  const f = fixture();
  try {
    await f.add(2);
    f.sql.exec(
      "INSERT INTO leases VALUES('P-DEMO','G-2','G-2','released','2026-10-01T00:00:00.000Z'),('P-OTHER','G-2','G-2','active','2026-10-01T00:00:00.000Z')",
    );
    assert.equal((await f.read({}, date)).face.gaps.length, 1);
  } finally {
    f.close();
  }
});
