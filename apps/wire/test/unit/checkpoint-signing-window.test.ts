import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import {
  checkpointSigningKey,
  signPendingCheckpoints,
  verifyCheckpointSignature,
} from "../../src/krater/checkpoint-signing.ts";
import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
} from "../../src/krater/krater.ts";

const RAW_KEY = JSON.stringify({ kid: "window-key", seedHex: "17".repeat(32) });
const NEXT_KEY = JSON.stringify({ kid: "rotated-key", seedHex: "28".repeat(32) });
const PROBLEM = "P-SIGNING-WINDOW";
const AT = "2026-10-01T00:00:00.000Z";

/** SQLite executes the real signer queries. The separate Workerd lane proves
 * D1 bindings; this fixture allows deliberate corruption of immutable rows. */
async function fixture(count: number) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, chain_digest TEXT, chain_version INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT, created_at TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT,
      harness TEXT, writer_credential_id TEXT, UNIQUE(problem_id,seq));
    CREATE TABLE event_chain_v2(event_id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER,
      row_digest TEXT, chain_digest TEXT, chain_version INTEGER, UNIQUE(problem_id,seq));
    CREATE TABLE integrity_checkpoints(problem_id TEXT, checkpoint_seq INTEGER,
      checkpoint_version INTEGER, checkpoint_mode TEXT, PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_chain_v2(problem_id TEXT, checkpoint_seq INTEGER,
      root_chain_digest TEXT, checkpoint_digest TEXT, chain_version INTEGER, PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_signatures(problem_id TEXT, checkpoint_seq INTEGER, key_id TEXT,
      algorithm TEXT, signature TEXT, signed_at TEXT, PRIMARY KEY(problem_id,checkpoint_seq,key_id));
  `);
  sql.exec(
    readFileSync(
      new URL("../../../../db/migrations/0119_checkpoint_signing_cursor.sql", import.meta.url),
      "utf8",
    ),
  );
  async function append(amount: number, problemId = PROBLEM) {
    const stored = sql
      .query("SELECT public_seq,chain_digest FROM problems WHERE id=?")
      .get(problemId) as { public_seq: number; chain_digest: string } | null;
    let seq = stored?.public_seq ?? 0;
    let previous = stored?.chain_digest ?? (await genesisChainDigest(problemId));
    if (!stored) sql.query("INSERT INTO problems VALUES(?,0,?,2)").run(problemId, previous);
    for (let index = 0; index < amount; index++) {
      seq++;
      const event = {
        eventId: `${problemId}-EV-${seq}`,
        problemId,
        seq,
        type: "claim.created",
        objectKind: "claim",
        objectId: `C-${seq}`,
        objectVersion: 1,
        payloadSha256: "a".repeat(64),
        createdAt: AT,
        actorFellowId: "F-author",
        actorSponsorId: "S-author",
        actorSessionId: "SES-author",
        modelStringSelfDeclared: "declared",
        harness: "unit",
        writerCredentialId: "cred-author",
      };
      const rowDigest = await eventEnvelopeRowDigest(event);
      previous = await eventChainDigest(problemId, seq, event.payloadSha256, rowDigest, previous);
      const digest = await checkpointDigest(problemId, seq, previous);
      sql
        .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          event.eventId,
          problemId,
          seq,
          event.type,
          event.objectKind,
          event.objectId,
          event.objectVersion,
          event.payloadSha256,
          AT,
          event.actorFellowId,
          event.actorSponsorId,
          event.actorSessionId,
          event.modelStringSelfDeclared,
          event.harness,
          event.writerCredentialId,
        );
      sql
        .query("INSERT INTO event_chain_v2 VALUES(?,?,?,?,?,2)")
        .run(event.eventId, problemId, seq, rowDigest, previous);
      sql
        .query("INSERT INTO integrity_checkpoints VALUES(?,?,1,'unsigned-v0')")
        .run(problemId, seq);
      sql
        .query("INSERT INTO checkpoint_chain_v2 VALUES(?,?,?,?,2)")
        .run(problemId, seq, previous, digest);
    }
    sql
      .query("UPDATE problems SET public_seq=?,chain_digest=? WHERE id=?")
      .run(seq, previous, problemId);
  }
  await append(count);
  const reads: { query: string; values: (string | number | null)[]; rows: number }[] = [];
  const hooks = {
    beforeBatch: undefined as undefined | (() => void | Promise<void>),
    beforeCursorAdvance: undefined as undefined | (() => void | Promise<void>),
  };
  function prepare(query: string) {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...input: (string | number | null)[]) {
        values = input;
        return statement;
      },
      async all() {
        assert.match(query, /LIMIT\s+(?:\?|50)/, "multi-row reads must be bounded in SQL");
        const results = sql.query(query).all(...values);
        assert.ok(results.length <= 201, "at most one anchor plus a 200-checkpoint window");
        reads.push({ query, values: [...values], rows: results.length });
        return { results };
      },
      async first() {
        return sql.query(query).get(...values);
      },
      execute() {
        return { meta: { changes: sql.query(query).run(...values).changes } };
      },
      async run() {
        if (query.includes("UPDATE checkpoint_signing_cursors"))
          await hooks.beforeCursorAdvance?.();
        return statement.execute();
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      await hooks.beforeBatch?.();
      return sql.transaction(() => statements.map((statement) => statement.execute()))();
    },
  } as unknown as D1Database;
  const signatures = () =>
    sql
      .query(`SELECT s.*, c.root_chain_digest,c.checkpoint_digest
    FROM checkpoint_signatures s JOIN checkpoint_chain_v2 c USING(problem_id,checkpoint_seq)
    ORDER BY s.key_id,s.checkpoint_seq`)
      .all() as {
      key_id: string;
      checkpoint_seq: number;
      root_chain_digest: string;
      checkpoint_digest: string;
      signature: string;
    }[];
  return { sql, db, reads, hooks, append, signatures };
}

test("451 checkpoints sign in bounded successive windows without reloading authenticated history or bodies", async () => {
  const f = await fixture(451);
  try {
    for (const expected of [200, 200, 51, 0])
      assert.deepEqual(await signPendingCheckpoints(f.db, RAW_KEY), {
        enabled: true,
        signed: expected,
        problems: expected > 0 ? 1 : 0,
      });
    const pages = f.reads.filter(({ query }) =>
      query.includes("WHERE e.problem_id = ? AND e.seq > ?"),
    );
    assert.deepEqual(
      pages.map(({ values, rows }) => [values[1], values[2], rows]),
      [
        [0, 200, 200],
        [200, 200, 200],
        [400, 51, 51],
      ],
    );
    const key = await checkpointSigningKey(RAW_KEY);
    assert.ok(key);
    for (const signature of f.signatures())
      assert.equal(await verifyCheckpointSignature(PROBLEM, signature, key.publicKeyHex), true);
  } finally {
    f.sql.close();
  }
}, 60_000);

test("limit is capped at 200; key rotation authenticates from genesis and fills every checkpoint", async () => {
  const f = await fixture(201);
  try {
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY, 9999)).signed, 200);
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 1);
    assert.equal((await signPendingCheckpoints(f.db, NEXT_KEY)).signed, 200);
    assert.equal((await signPendingCheckpoints(f.db, NEXT_KEY)).signed, 1);
    assert.equal(f.signatures().length, 402);
    const pages = f.reads.filter(({ query }) =>
      query.includes("WHERE e.problem_id = ? AND e.seq > ?"),
    );
    assert.deepEqual(
      pages.map(({ values }) => values[1]),
      [0, 200, 0, 200],
    );
  } finally {
    f.sql.close();
  }
}, 60_000);

test("the earliest missing signature is repaired even when later checkpoints are already signed", async () => {
  const f = await fixture(251);
  try {
    await signPendingCheckpoints(f.db, RAW_KEY);
    await signPendingCheckpoints(f.db, RAW_KEY);
    f.sql.exec("DELETE FROM checkpoint_signatures WHERE checkpoint_seq=53");
    f.reads.length = 0;
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 1);
    assert.equal(f.signatures().length, 251);
    const page = f.reads.find(({ query }) =>
      query.includes("WHERE e.problem_id = ? AND e.seq > ?"),
    );
    assert.equal(page?.values[1], 52);
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 0);
  } finally {
    f.sql.close();
  }
}, 60_000);

const corruptions = {
  envelope: "UPDATE events SET actor_fellow_id='F-forged' WHERE seq=3",
  row_digest: "UPDATE event_chain_v2 SET row_digest=printf('%064d',0) WHERE seq=3",
  chain: "UPDATE event_chain_v2 SET chain_digest=printf('%064d',0) WHERE seq=3",
  checkpoint_digest:
    "UPDATE checkpoint_chain_v2 SET checkpoint_digest=printf('%064d',0) WHERE checkpoint_seq=3",
  checkpoint_mode:
    "UPDATE integrity_checkpoints SET checkpoint_mode='other' WHERE checkpoint_seq=3",
  checkpoint_version:
    "UPDATE integrity_checkpoints SET checkpoint_version=2 WHERE checkpoint_seq=3",
  missing_checkpoint: "DELETE FROM integrity_checkpoints WHERE checkpoint_seq=3",
  missing_event: "DELETE FROM events WHERE seq=3",
  missing_chain: "DELETE FROM event_chain_v2 WHERE seq=3",
  head_root: "UPDATE problems SET chain_digest=printf('%064d',0)",
  anchor_signature:
    "UPDATE checkpoint_signatures SET signature=printf('%0128d',0) WHERE checkpoint_seq=2",
  anchor_checkpoint:
    "UPDATE checkpoint_chain_v2 SET checkpoint_digest=printf('%064d',0) WHERE checkpoint_seq=2",
  anchor_root:
    "UPDATE checkpoint_chain_v2 SET root_chain_digest=printf('%064d',0) WHERE checkpoint_seq=2",
};
for (const [kind, damage] of Object.entries(corruptions))
  test(`a corrupt ${kind} cannot authenticate the pending suffix`, async () => {
    const f = await fixture(4);
    try {
      assert.equal((await signPendingCheckpoints(f.db, RAW_KEY, 2)).signed, 2);
      f.sql.exec(damage);
      assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 0);
      assert.equal(f.signatures().length, 2);
    } finally {
      f.sql.close();
    }
  });

test("reusing a key ID with a different secret cannot trust its prior signature", async () => {
  const f = await fixture(4);
  try {
    await signPendingCheckpoints(f.db, RAW_KEY, 2);
    const wrongKey = JSON.stringify({ kid: "window-key", seedHex: "39".repeat(32) });
    assert.equal((await signPendingCheckpoints(f.db, wrongKey)).signed, 0);
  } finally {
    f.sql.close();
  }
});

test("a checkpoint changed after verification is not signed or counted", async () => {
  const f = await fixture(1);
  try {
    f.hooks.beforeBatch = () => {
      f.sql.exec("UPDATE checkpoint_chain_v2 SET checkpoint_digest=printf('%064d',0)");
    };
    assert.deepEqual(await signPendingCheckpoints(f.db, RAW_KEY), {
      enabled: true,
      signed: 0,
      problems: 0,
    });
    assert.equal(f.signatures().length, 0);
  } finally {
    f.sql.close();
  }
});

test("an anchor changed after verification cannot admit later signatures", async () => {
  const f = await fixture(4);
  try {
    await signPendingCheckpoints(f.db, RAW_KEY, 2);
    f.hooks.beforeBatch = () => {
      f.sql.exec(
        "UPDATE checkpoint_signatures SET signature=printf('%0128d',0) WHERE checkpoint_seq=2",
      );
    };
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 0);
    assert.equal(f.signatures().length, 2);
  } finally {
    f.sql.close();
  }
});

test("overlapping ticks count actual insertions and still bound each attempted window", async () => {
  const f = await fixture(225);
  try {
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    f.hooks.beforeBatch = async () => {
      if (++arrivals === 2) release?.();
      await ready;
    };
    const results = await Promise.all([
      signPendingCheckpoints(f.db, RAW_KEY),
      signPendingCheckpoints(f.db, RAW_KEY),
    ]);
    assert.deepEqual(
      results.map(({ signed }) => signed).sort((a, b) => a - b),
      [0, 200],
    );
    assert.deepEqual(results.map(({ problems }) => problems).sort(), [0, 1]);
    assert.equal(f.signatures().length, 200);
    f.hooks.beforeBatch = undefined;
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 25);
  } finally {
    f.sql.close();
  }
}, 60_000);

test("an append racing the captured head is left for the next bounded tick", async () => {
  const f = await fixture(3);
  try {
    f.hooks.beforeBatch = () => f.append(2);
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 3);
    f.hooks.beforeBatch = undefined;
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, 2);
  } finally {
    f.sql.close();
  }
});

test("a corrupt large first scope cannot starve a healthy scope, including overlapping ticks", async () => {
  const f = await fixture(225);
  const broken = "P-A-BROKEN";
  try {
    await f.append(225, broken);
    f.sql
      .query("UPDATE events SET actor_fellow_id='F-forged' WHERE problem_id=? AND seq=1")
      .run(broken);
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    f.hooks.beforeBatch = async () => {
      if (++arrivals === 2) release?.();
      await ready;
    };
    const results = await Promise.all([
      signPendingCheckpoints(f.db, RAW_KEY),
      signPendingCheckpoints(f.db, RAW_KEY),
    ]);
    assert.deepEqual(
      results.map(({ signed }) => signed).sort((a, b) => a - b),
      [0, 100],
    );
    const eventPages = () =>
      f.reads.filter(({ query }) => query.includes("WHERE e.problem_id = ? AND e.seq > ?"));
    assert.equal(eventPages().length, 4);
    assert.ok(eventPages().every(({ rows }) => rows === 100));
    assert.equal(
      eventPages().reduce((total, { rows }) => total + rows, 0),
      400,
      "each overlapping tick validates at most 200 events across both scopes",
    );
    f.hooks.beforeBatch = undefined;
    for (const expected of [100, 25]) {
      f.reads.length = 0;
      assert.equal((await signPendingCheckpoints(f.db, RAW_KEY)).signed, expected);
      assert.ok(eventPages().reduce((total, { rows }) => total + rows, 0) <= 200);
    }
    assert.equal(f.signatures().length, 225);
    assert.equal(
      (
        f.sql
          .query("SELECT COUNT(*) AS total FROM checkpoint_signatures WHERE problem_id=?")
          .get(broken) as { total: number }
      ).total,
      0,
    );
  } finally {
    f.sql.close();
  }
}, 60_000);

test("malformed keys disable signing without any database work", async () => {
  const db = {
    prepare() {
      throw new Error("must not query");
    },
  } as unknown as D1Database;
  for (const raw of [undefined, "", "not-json", "{}"])
    assert.deepEqual(await signPendingCheckpoints(db, raw), {
      enabled: false,
      signed: 0,
      problems: 0,
    });
});

test("round-robin progress crosses 50 corrupt scopes, excludes legacy scopes, and isolates rotated keys", async () => {
  const f = await fixture(7);
  try {
    for (let index = 0; index < 50; index++) {
      const problem = `P-A-${String(index).padStart(3, "0")}`;
      await f.append(5, problem);
      f.sql
        .query("UPDATE events SET actor_fellow_id='F-forged' WHERE problem_id=? AND seq=1")
        .run(problem);
    }
    for (let index = 0; index < 50; index++) {
      const problem = `P-0-${String(index).padStart(3, "0")}`;
      await f.append(1, problem);
      f.sql.query("UPDATE problems SET chain_version=NULL WHERE id=?").run(problem);
    }
    const cursor = (key: string) =>
      f.sql
        .query("SELECT after_problem_id,revision FROM checkpoint_signing_cursors WHERE key_id=?")
        .get(key) as { after_problem_id: string | null; revision: number };
    for (const [raw, key] of [
      [RAW_KEY, "window-key"],
      [NEXT_KEY, "rotated-key"],
    ] as const) {
      f.reads.length = 0;
      assert.equal((await signPendingCheckpoints(f.db, raw)).signed, 0);
      assert.deepEqual(cursor(key), { after_problem_id: "P-A-049", revision: 1 });
      const pages = f.reads.filter(({ query }) =>
        query.includes("WHERE e.problem_id = ? AND e.seq > ?"),
      );
      assert.equal(pages.length, 50);
      assert.equal(
        pages.reduce((total, { rows }) => total + rows, 0),
        200,
      );
      assert.equal(
        (await signPendingCheckpoints(f.db, raw)).signed,
        7,
        "the healthy 51st eligible scope is reached on the next tick",
      );
      assert.deepEqual(cursor(key), { after_problem_id: PROBLEM, revision: 2 });
    }
    assert.equal(f.signatures().length, 14);
    assert.deepEqual(
      cursor("window-key"),
      { after_problem_id: PROBLEM, revision: 2 },
      "the rotated key cannot move the original key's cursor",
    );
  } finally {
    f.sql.close();
  }
}, 60_000);

test("an older tick cannot rewind a newer cursor after wrap; small limits do not skip unattempted scopes", async () => {
  const f = await fixture(0);
  try {
    for (const problem of ["P-A-000", "P-A-001", "P-A-002"]) await f.append(1, problem);
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updates = 0;
    f.hooks.beforeCursorAdvance = async () => {
      if (++updates === 1) {
        entered?.();
        await resume;
      }
    };
    const older = signPendingCheckpoints(f.db, RAW_KEY, 1);
    await paused;
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY, 1)).signed, 1);
    let cursor = f.sql
      .query("SELECT after_problem_id,revision FROM checkpoint_signing_cursors")
      .get();
    assert.deepEqual(cursor, { after_problem_id: "P-A-001", revision: 1 });
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY, 1)).signed, 1);
    assert.equal((await signPendingCheckpoints(f.db, RAW_KEY, 1)).signed, 0);
    cursor = f.sql.query("SELECT after_problem_id,revision FROM checkpoint_signing_cursors").get();
    assert.deepEqual(cursor, { after_problem_id: null, revision: 3 });
    release?.();
    assert.equal((await older).signed, 1);
    assert.deepEqual(
      f.sql.query("SELECT after_problem_id,revision FROM checkpoint_signing_cursors").get(),
      cursor,
      "revision CAS prevents ABA even after the cursor returns to null",
    );
    assert.equal(f.signatures().length, 3);
  } finally {
    f.sql.close();
  }
}, 60_000);
