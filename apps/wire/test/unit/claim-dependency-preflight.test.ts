import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  ClaimDependencyAdmissionError,
  requireLiveClaimDependencyClosure,
} from "../../src/ledger/claim-dependency-preflight";
import {
  readScientificClaim,
  resolveClaimDependencies,
  ScientificInputError,
} from "../../src/ledger/scientific-checks";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

/** This exercises production recursive SQL and source-byte verification. The
 * D1-shaped adapter delegates to SQLite; it does not invent rows or verdicts.
 * HTTP authority, screening and native Workerd remain separate integration. */
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_id TEXT,
      object_version INTEGER, type TEXT, object_kind TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE claim_versions (problem_id TEXT, claim_id TEXT, version INTEGER, content_digest TEXT, statement TEXT,
      PRIMARY KEY (problem_id, claim_id, version));
    CREATE TABLE retractions (problem_id TEXT, retraction_id TEXT, target_object TEXT,
      seq INTEGER, author_fellow_id TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO problems VALUES ('P-TEST', 0, 'active'), ('P-OTHER', 0, 'active');
  `);
  let sequence = 0, reads = 0;
  const batches: number[] = [];
  const prepared = new WeakMap<object, () => unknown[]>();
  const d1 = {
    prepare(sql: string) { return { bind(...args: (string | number | null)[]) {
      const run = () => { reads++; return db.prepare(sql).all(...args); };
      const statement = { all: async () => ({ results: run() }), first: async () => run()[0] ?? null };
      prepared.set(statement, run); return statement;
    } }; },
    async batch(statements: D1PreparedStatement[]) {
      batches.push(statements.length); db.exec("BEGIN");
      try {
        const output = statements.map(statement => {
          const run = prepared.get(statement); if (!run) throw new Error("Unknown statement");
          return { results: run() };
        });
        db.exec("COMMIT"); return output;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  const claim = (id: number, pins: unknown = [], { version = 1, problem = "P-TEST", padding = "", author = "F-A" } = {}) => {
    const seq = ++sequence, event = `EV-${seq}`, claimId = `C-${id}`;
    const statement = `Exact statement ${id} version ${version}.`;
    const payload = JSON.stringify({ claim_id: claimId, statement, kind: "lemma", dependency_pins: pins,
      ...(version > 1 ? { base_version: version - 1 } : {}), padding });
    const hash = digest(payload), content = `sha256:${digest(statement)}`;
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, 'claim', ?, ?, 'SP-A', 'SS-A', 'declared', 'harness')")
      .run(event, problem, seq, claimId, version, version === 1 ? "claim.created" : "claim.revised", hash, author);
    db.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(event, hash, payload);
    db.prepare("INSERT INTO claim_versions VALUES (?, ?, ?, ?, ?)").run(problem, claimId, version, content, statement);
    db.prepare("UPDATE problems SET public_seq = ? WHERE id = ?").run(seq, problem);
    return { claim_id: claimId, version, event_id: event, payload_digest: hash, content_digest: content };
  };
  const chain = () => { const leaf = claim(1), middle = claim(2, [leaf]), root = claim(3, [middle]); return { leaf, middle, root }; };
  const withdraw = (target: string, problem = "P-TEST", author = "F-A") => {
    db.prepare("INSERT INTO retractions VALUES (?, ?, ?, ?, ?)").run(problem, `RT-${++sequence}`, target, sequence, author);
    db.prepare("UPDATE problems SET public_seq = ? WHERE id = ?").run(sequence, problem);
  };
  const check = (pins: Parameters<typeof requireLiveClaimDependencyClosure>[2], problem = "P-TEST") =>
    requireLiveClaimDependencyClosure(d1, problem, pins);
  return { db, d1, claim, chain, withdraw, check, batches, reads: () => reads };
}

const refused = (result: Promise<void>) => assert.rejects(result, ClaimDependencyAdmissionError);

test("empty dependencies require no database work", async () => {
  const f = fixture(); await f.check([]); assert.equal(f.reads(), 0);
});

test("live roots with shared ancestry are checked in one captured-cut batch", async () => {
  const f = fixture(), { root, middle } = f.chain();
  await f.check([root, middle]); assert.deepEqual(f.batches, [2]);
});

for (const target of ["C-1", "C-1@1", "C-3", "C-3@1"]) {
  test(`direct and indirect withdrawal ${target} prevents publication preflight`, async () => {
    const f = fixture(), { root } = f.chain(); f.withdraw(target); await refused(f.check([root]));
  });
}

test("same-named foreign withdrawals and non-author withdrawals do not close a local premise", async () => {
  const f = fixture(), { root } = f.chain(); f.claim(1, [], { problem: "P-OTHER" });
  f.withdraw("C-1", "P-OTHER"); f.withdraw("C-1", "P-TEST", "F-B"); await f.check([root]);
});

test("an old-version withdrawal does not close a current version", async () => {
  const f = fixture(); f.claim(1); f.withdraw("C-1@1");
  const current = f.claim(1, [], { version: 2 }); await f.check([current]);
});

for (const id of [1, 2, 3]) {
  test(`a later revision of C-${id} requires chain reanchoring, not silent retargeting`, async () => {
    const f = fixture(), { root } = f.chain(); f.claim(id, [], { version: 2 }); await refused(f.check([root]));
  });
}

test("the reanchored live chain becomes eligible again", async () => {
  const f = fixture(); f.chain(); const leaf = f.claim(1, [], { version: 2 });
  const middle = f.claim(2, [leaf], { version: 2 }), root = f.claim(3, [middle], { version: 2 });
  await f.check([root]);
});

for (const target of ["C-1", "C-2", "C-3", "problem"]) {
  test(`hidden ${target} refuses and latest restore restores eligibility`, async () => {
    const f = fixture(), { root } = f.chain();
    f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 'hidden', 1)").run(target);
    await refused(f.check([root]));
    f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 'public', 2)").run(target);
    await f.check([root]);
  });
}

for (const sql of [
  "UPDATE event_content SET redacted_at='now' WHERE event_id='EV-1'",
  "UPDATE event_content SET payload_sha256='detached' WHERE event_id='EV-2'",
  "UPDATE event_content SET payload_json=replace(payload_json,'Exact statement 1','Altered statement 1') WHERE event_id='EV-1'",
  "UPDATE event_content SET payload_json=replace(payload_json,'Exact statement 3','Altered statement 3') WHERE event_id='EV-3'",
  "UPDATE claim_versions SET content_digest='different' WHERE claim_id='C-1'",
]) {
  test(`source verification rejects incomplete or altered ancestry: ${sql}`, async () => {
    const f = fixture(), { root } = f.chain(); f.db.exec(sql); await refused(f.check([root]));
  });
}

for (const [field, value] of [["event_id", "missing"], ["payload_digest", "0".repeat(64)], ["content_digest", `sha256:${"0".repeat(64)}`]] as const) {
  test(`the resolved root must still match its exact ${field}`, async () => {
    const f = fixture(), { root } = f.chain(); await refused(f.check([{ ...root, [field]: value }]));
  });
}

for (const pins of [null, "C-1", {}, [{ event_id: "missing" }]]) {
  test(`unknown legacy/malformed ancestry is not an empty graph: ${JSON.stringify(pins)}`, async () => {
    const f = fixture(), root = f.claim(1, pins); await refused(f.check([root]));
  });
}

test("private drafts cannot supply public premise ancestry", async () => {
  const f = fixture(), { root } = f.chain();
  f.db.exec("UPDATE problems SET status='private-draft' WHERE id='P-TEST'"); await refused(f.check([root]));
});

test("foreign publications cannot be reused under a local pin", async () => {
  const f = fixture(), root = f.claim(1, [], { problem: "P-OTHER" }); await refused(f.check([root]));
});

test("publication boundary rejects an unpublished root but ignores a later uncommitted revision", async () => {
  const f = fixture(), { root } = f.chain();
  f.db.exec("UPDATE problems SET public_seq=2 WHERE id='P-TEST'"); await refused(f.check([root]));
  f.db.exec("UPDATE problems SET public_seq=3 WHERE id='P-TEST'"); f.claim(1, [], { version: 2 });
  f.db.exec("UPDATE problems SET public_seq=3 WHERE id='P-TEST'"); await f.check([root]);
});

test("duplicate and over-bound direct roots are refused before reads", async () => {
  const f = fixture(), pin = f.claim(1);
  await refused(f.check([pin, pin])); assert.equal(f.reads(), 0);
  const pins = Array.from({ length: 17 }, (_, i) => f.claim(i + 2));
  await refused(f.check(pins)); assert.equal(f.reads(), 0);
});

test("the merged ancestry budget reserves one node for the incoming publication", async () => {
  const f = fixture(); let pin = f.claim(1);
  for (let n = 2; n <= 63; n++) pin = f.claim(n, [pin]);
  await f.check([pin]); pin = f.claim(64, [pin]); await refused(f.check([pin]));
});

test("separately bounded roots cannot bypass the merged forest node bound", async () => {
  const f = fixture(); let left = f.claim(1), right = f.claim(100);
  for (let n = 2; n <= 32; n++) { left = f.claim(n, [left]); right = f.claim(100 + n, [right]); }
  await refused(f.check([left, right]));
});

test("shared large ancestry is counted once across roots", async () => {
  const f = fixture(), leaf = f.claim(1, [], { padding: "x".repeat(60000) });
  const roots = Array.from({ length: 16 }, (_, i) => f.claim(i + 2, [leaf])); await f.check(roots);
});

test("individually bounded roots cannot bypass the merged UTF-8 byte budget", async () => {
  const f = fixture(), roots = Array.from({ length: 5 }, (_, i) => f.claim(i + 1, [], { padding: "x".repeat(60000) }));
  await f.check(roots.slice(0, 4)); await refused(f.check(roots));
});

test("an oversized UTF-8 source never becomes a silently accepted leaf", async () => {
  const f = fixture(), root = f.claim(1, [], { padding: "é".repeat(32768) }); await refused(f.check([root]));
});

test("storage errors remain errors, not no-dependency success", async () => {
  const f = fixture(), { root } = f.chain(); f.db.exec("ALTER TABLE retractions RENAME TO missing_retractions");
  await assert.rejects(f.check([root]), /no such table/);
});

test("the production dependency resolver awaits preflight and retains only direct pins", async () => {
  const f = fixture(), { root } = f.chain();
  assert.deepEqual(await resolveClaimDependencies(f.d1, "P-TEST", ["C-3"]), [root]);
  f.withdraw("C-1");
  await assert.rejects(resolveClaimDependencies(f.d1, "P-TEST", ["C-3"]), ScientificInputError);
});

test("the publication resolver rejects tampered ancestor bytes, not just direct source mismatches", async () => {
  const f = fixture(); f.chain();
  f.db.exec("UPDATE event_content SET payload_json=replace(payload_json,'Exact statement 1','Tampered ancestor') WHERE event_id='EV-1'");
  await assert.rejects(resolveClaimDependencies(f.d1, "P-TEST", ["C-3"]), ScientificInputError);
});

test("exact-version scientific reads remain available for historical review", async () => {
  const f = fixture(); f.chain(); f.withdraw("C-1");
  assert.equal((await readScientificClaim(f.d1, "P-TEST", "C-3", 1)).version, 1);
  await assert.rejects(resolveClaimDependencies(f.d1, "P-TEST", ["C-3"]), ScientificInputError);
});

test("preflight success cannot bypass a withdrawal before transactional settlement", async () => {
  const f = fixture(); f.chain();
  const pins = await resolveClaimDependencies(f.d1, "P-TEST", ["C-3"]);
  f.db.exec("CREATE TABLE idempotency (problem_id TEXT, idempotency_key TEXT, event_id TEXT, event_seq INTEGER)");
  f.db.exec(readFileSync(new URL("../../../../db/migrations/0098_claim_dependency_admission.sql", import.meta.url), "utf8"));
  f.withdraw("C-1");
  const before = JSON.stringify(f.db.prepare("SELECT * FROM problems ORDER BY id").all());
  f.db.exec("BEGIN");
  try {
    const published = f.claim(4, pins);
    f.db.exec("INSERT INTO idempotency VALUES ('P-TEST', 'lost-race', NULL, NULL)");
    assert.throws(() => f.db.prepare("UPDATE idempotency SET event_id=? WHERE idempotency_key='lost-race'")
      .run(published.event_id), /SCIENTIFIC_REFERENCE_CHANGED/);
  } finally { f.db.exec("ROLLBACK"); }
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM problems ORDER BY id").all()), before);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE object_id='C-4'").get() as { n: number }).n, 0);
});
