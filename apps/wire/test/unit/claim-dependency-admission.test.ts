import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";

const migration = readFileSync(new URL("../../../../db/migrations/0098_claim_dependency_admission.sql", import.meta.url), "utf8");
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
/** Real SQLite, no D1/mock verdicts. The transaction reproduces the order
 * used by Krater: replay claim -> cursor -> event/content/outbox -> replay
 * settlement -> companion version/projection/sealed replay writes. These
 * are storage-invariant tests, not mounted Worker/authorization proof. */
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id),
      seq INTEGER NOT NULL, type TEXT NOT NULL, object_kind TEXT NOT NULL, object_id TEXT NOT NULL,
      object_version INTEGER NOT NULL, payload_sha256 TEXT NOT NULL, actor_fellow_id TEXT NOT NULL,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY REFERENCES events(id), payload_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL, redacted_at TEXT);
    CREATE TABLE claim_versions (problem_id TEXT NOT NULL, claim_id TEXT NOT NULL, version INTEGER NOT NULL,
      content_digest TEXT NOT NULL, PRIMARY KEY(problem_id, claim_id, version));
    CREATE TABLE idempotency (problem_id TEXT NOT NULL REFERENCES problems(id), idempotency_key TEXT NOT NULL,
      event_id TEXT REFERENCES events(id), event_seq INTEGER, PRIMARY KEY(problem_id, idempotency_key));
    CREATE TABLE retractions (problem_id TEXT NOT NULL, retraction_id TEXT NOT NULL, target_object TEXT NOT NULL,
      seq INTEGER NOT NULL, author_fellow_id TEXT NOT NULL, PRIMARY KEY(problem_id, retraction_id));
    CREATE TABLE content_controls (problem_id TEXT NOT NULL, target_ref TEXT NOT NULL, version INTEGER NOT NULL,
      visibility TEXT NOT NULL, PRIMARY KEY(problem_id, target_ref, version));
    CREATE TABLE outbox (event_id TEXT PRIMARY KEY REFERENCES events(id));
    CREATE TABLE claim_projections (problem_id TEXT, claim_id TEXT, source_seq INTEGER,
      PRIMARY KEY(problem_id, claim_id));
    CREATE TABLE session_write_replays (idempotency_key TEXT PRIMARY KEY, response TEXT);
    CREATE TABLE quota (consumed INTEGER NOT NULL);
    INSERT INTO quota VALUES (0);
    INSERT INTO problems VALUES ('P-TEST', 0, 'active'), ('P-OTHER', 0, 'active');
  `);
  db.exec(migration);
  let serial = 0;
  const atomic = <T>(action: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const append = (id: string, body: Record<string, unknown>, {
    problem = "P-TEST", version = 1, type = "claim.created", kind = "claim", author = "F-A", settle = true,
  } = {}) => {
    const event = `EV-${++serial}`, payload = JSON.stringify(body), hash = digest(payload);
    const seq = (db.prepare("SELECT public_seq FROM problems WHERE id = ?").get(problem) as { public_seq: number }).public_seq + 1;
    if (settle) db.prepare("INSERT INTO idempotency VALUES (?, ?, NULL, NULL)").run(problem, event);
    db.prepare("UPDATE problems SET public_seq = ? WHERE id = ?").run(seq, problem);
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event, problem, seq, type, kind, id, version, hash, author);
    db.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(event, hash, payload);
    db.prepare("INSERT INTO outbox VALUES (?)").run(event);
    // Exercise rollback of side effects already written before settlement.
    db.exec("UPDATE quota SET consumed = consumed + 1");
    if (settle) db.prepare("UPDATE idempotency SET event_id = ?, event_seq = ? WHERE problem_id = ? AND idempotency_key = ?").run(event, seq, problem, event);
    if (kind === "claim") {
      db.prepare("INSERT INTO claim_versions VALUES (?, ?, ?, ?)").run(problem, id, version, `sha256:${digest(String(body.statement))}`);
      db.prepare("INSERT INTO claim_projections VALUES (?, ?, ?) ON CONFLICT (problem_id, claim_id) DO UPDATE SET source_seq = excluded.source_seq").run(problem, id, seq);
    }
    if (settle) db.prepare("INSERT INTO session_write_replays VALUES (?, ?)").run(event, JSON.stringify({ event, seq }));
    return { claim_id: id, version, event_id: event, payload_digest: hash, content_digest: `sha256:${digest(String(body.statement))}` };
  };
  const claim = (id: number, pins: unknown = [], opts: { version?: number; problem?: string; settle?: boolean; padding?: string; omitPins?: boolean } = {}) => atomic(() => append(`C-${id}`, {
    claim_id: `C-${id}`, kind: "lemma", statement: `Exact statement ${id}, version ${opts.version ?? 1}.`,
    ...(opts.omitPins ? {} : { dependency_pins: pins }),
    ...((opts.version ?? 1) > 1 ? { base_version: opts.version! - 1 } : {}),
    ...(opts.padding === undefined ? {} : { padding: opts.padding }),
  }, { ...opts, type: (opts.version ?? 1) > 1 ? "claim.revised" : "claim.created" }));
  const chain = () => { const leaf = claim(1); const middle = claim(2, [leaf]); return { leaf, middle, root: claim(3, [middle]) }; };
  const withdraw = (target: string, { author = "F-A", problem = "P-TEST" } = {}) => atomic(() => {
    const id = `RT-${serial + 1}`;
    const event = append(id, { target_object: target }, { type: "object.retracted", kind: "retraction", problem, author });
    const seq = (db.prepare("SELECT seq FROM events WHERE id = ?").get(event.event_id) as { seq: number }).seq;
    db.prepare("INSERT INTO retractions VALUES (?, ?, ?, ?, ?)").run(problem, id, target, seq, author);
    return event;
  });
  const snapshot = () => JSON.stringify(["problems", "events", "event_content", "claim_versions", "idempotency",
    "retractions", "outbox", "claim_projections", "session_write_replays", "quota"].map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const refuses = (action: () => unknown) => { const before = snapshot(); assert.throws(action, /SCIENTIFIC_REFERENCE_CHANGED/); assert.equal(snapshot(), before); };
  return { db, atomic, append, claim, chain, withdraw, snapshot, refuses };
}

test("modern leaf, direct chain and shared diamond publish with one replay per event", () => {
  const f = fixture(), { leaf, middle, root } = f.chain();
  const left = f.claim(4, [leaf, root]); f.claim(5, [left, middle]);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE event_id IS NOT NULL").get() as { n: number }).n, 5);
  assert.equal((f.db.prepare("SELECT consumed FROM quota").get() as { consumed: number }).consumed, 5);
});

for (const target of ["C-1", "C-1@1"]) {
  test(`a transitive withdrawal of ${target} aborts every publication side effect`, () => {
    const f = fixture(), { root } = f.chain(); f.withdraw(target);
    f.refuses(() => f.claim(4, [root]));
  });
}

test("a direct withdrawal racing a prepared pin also aborts settlement", () => {
  const f = fixture(), leaf = f.claim(1); f.withdraw("C-1");
  f.refuses(() => f.claim(2, [leaf]));
});

test("a late premise revision cannot silently retarget a transitive dependency", () => {
  const f = fixture(), { root } = f.chain(); f.claim(1, [], { version: 2 });
  f.refuses(() => f.claim(4, [root]));
});

test("reanchoring the entire chain on current versions allows publication again", () => {
  const f = fixture(); f.chain(); const leaf = f.claim(1, [], { version: 2 });
  const middle = f.claim(2, [leaf], { version: 2 }); const root = f.claim(3, [middle], { version: 2 });
  assert.equal(f.claim(4, [root]).version, 1);
});

test("revision can remove a failed route instead of inheriting obsolete pins", () => {
  const f = fixture(); f.chain(); f.withdraw("C-1");
  assert.equal(f.claim(3, [], { version: 2 }).version, 2);
});

for (const target of ["C-1", "C-2", "problem"]) {
  test(`current hide of ${target} cannot race a prepared dependency pin`, () => {
    const f = fixture(), { root } = f.chain();
    f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 1, 'hidden')").run(target);
    f.refuses(() => f.claim(4, [root]));
    f.db.prepare("INSERT INTO content_controls VALUES ('P-TEST', ?, 2, 'public')").run(target);
    assert.equal(f.claim(4, [root]).version, 1);
  });
}

for (const sql of [
  "UPDATE event_content SET redacted_at = 'now' WHERE event_id = 'EV-1'",
  "UPDATE event_content SET payload_sha256 = 'detached' WHERE event_id = 'EV-1'",
  "UPDATE claim_versions SET content_digest = 'wrong' WHERE claim_id = 'C-1'",
]) {
  test(`an unavailable transitive publication fails closed: ${sql}`, () => {
    const f = fixture(), { root } = f.chain(); f.db.exec(sql);
    f.refuses(() => f.claim(4, [root]));
  });
}

test("a retained withdrawal does not disappear when its explanation is redacted", () => {
  const f = fixture(), { root } = f.chain(), withdrawal = f.withdraw("C-1");
  f.db.prepare("UPDATE event_content SET redacted_at = 'now' WHERE event_id = ?").run(withdrawal.event_id);
  f.refuses(() => f.claim(4, [root]));
});

test("a legacy withdrawal lacking an event cannot establish fresh ancestry", () => {
  const f = fixture(), { root } = f.chain();
  f.db.exec("INSERT INTO retractions VALUES ('P-TEST', 'RT-legacy', 'C-1', 3, 'F-A')");
  f.refuses(() => f.claim(4, [root]));
});

test("withdrawals in another problem do not close same-named local premises", () => {
  const f = fixture(), { root } = f.chain(); f.claim(1, [], { problem: "P-OTHER" });
  f.withdraw("C-1", { problem: "P-OTHER" }); assert.equal(f.claim(4, [root]).version, 1);
});

test("a non-author's projection cannot withdraw another author's claim", () => {
  const f = fixture(), { root } = f.chain(); f.withdraw("C-1", { author: "F-B" });
  assert.equal(f.claim(4, [root]).version, 1);
});

test("an old-version withdrawal does not close a new pinned version", () => {
  const f = fixture(); f.claim(1); f.withdraw("C-1@1");
  const current = f.claim(1, [], { version: 2 }); assert.equal(f.claim(2, [current]).version, 1);
});

test("historical review and retraction writes remain allowed after a premise closes", () => {
  const f = fixture(); f.chain(); f.withdraw("C-1");
  f.atomic(() => f.append("R-1", { target_claim_id: "C-3", target_version: 1, verdict: "refute" }, { type: "review.created", kind: "review", author: "F-B" }));
  f.withdraw("C-3");
});

test("settled replay metadata is not rejudged after a premise closes", () => {
  const f = fixture(), { root } = f.chain(); f.withdraw("C-1");
  const before = f.snapshot();
  f.db.prepare("UPDATE idempotency SET event_id = event_id WHERE event_id = ?").run(root.event_id);
  assert.equal(f.snapshot(), before);
});

test("ledger-only historical restore does not attempt a fresh replay settlement", () => {
  const f = fixture(), { root } = f.chain(); f.withdraw("C-1");
  assert.equal(f.claim(4, [root], { settle: false }).version, 1);
});

test("legacy root writes without a pin list stay readable but cannot become complete premises", () => {
  const f = fixture(), legacy = f.claim(1, [], { omitPins: true });
  f.refuses(() => f.claim(2, [legacy]));
});

for (const pins of [null, "C-1", {}, [null], ["C-1"], [7], [{ event_id: "absent" }]]) {
  test(`malformed declared ancestry refuses rather than pretending empty: ${JSON.stringify(pins)}`, () => {
    const f = fixture(); f.refuses(() => f.claim(1, pins));
  });
}

for (const [field, value] of [
  ["event_id", "missing"], ["claim_id", "C-9"], ["version", 2], ["version", "1"],
  ["payload_digest", "0".repeat(64)], ["content_digest", `sha256:${"0".repeat(64)}`],
] as const) {
  test(`a forged direct pin ${field} is not an authority`, () => {
    const f = fixture(), leaf = f.claim(1);
    f.refuses(() => f.claim(2, [{ ...leaf, [field]: value }]));
  });
}

test("a real foreign event cannot be substituted for a problem-local premise", () => {
  const f = fixture(), foreign = f.claim(1, [], { problem: "P-OTHER" });
  f.refuses(() => f.claim(2, [foreign]));
});

test("same-identity ancestry through an earlier version is not a lawful DAG", () => {
  const f = fixture(), old = f.claim(1), child = f.claim(2, [old]);
  f.refuses(() => f.claim(1, [child], { version: 2 }));
});

test("64 publications including the incoming claim are allowed; 65 are refused", () => {
  const f = fixture(); let pin = f.claim(1);
  for (let i = 2; i <= 64; i++) pin = f.claim(i, [pin]);
  f.refuses(() => f.claim(65, [pin]));
});

test("shared diamonds are deduplicated before the traversal limit", () => {
  const f = fixture(); const leaves = Array.from({ length: 16 }, (_, i) => f.claim(i + 1));
  const branches = Array.from({ length: 16 }, (_, i) => f.claim(i + 17, leaves));
  assert.equal(f.claim(33, branches).version, 1);
});

test("17 pins cannot be hidden behind a 16-edge exploration cutoff", () => {
  const f = fixture(); const leaves = Array.from({ length: 16 }, (_, i) => f.claim(i + 1));
  f.refuses(() => f.claim(17, [...leaves, leaves[0]]));
  const legacy = f.claim(18, [...leaves, leaves[0]], { settle: false });
  f.refuses(() => f.claim(19, [legacy]));
});

test("over-bound UTF-8 source bytes cannot create a silent leaf", () => {
  const f = fixture(), huge = f.claim(1, [], { settle: false, padding: "é".repeat(32768) });
  f.refuses(() => f.claim(2, [huge]));
});

test("aggregate source byte budget refuses the graph, not a skipped ancestor", () => {
  const f = fixture(); const leaves = Array.from({ length: 5 }, (_, i) => f.claim(i + 1, [], { padding: "x".repeat(60000) }));
  f.refuses(() => f.claim(6, leaves));
  assert.equal(f.claim(6, leaves.slice(0, 4)).version, 1);
});

test("failure in a later atomic batch member rolls back its already-settled predecessor", () => {
  const f = fixture(), { root } = f.chain(); f.withdraw("C-1");
  f.refuses(() => f.atomic(() => {
    f.append("C-4", { claim_id: "C-4", statement: "Valid independent first member.", dependency_pins: [] });
    f.append("C-5", { claim_id: "C-5", statement: "Invalid dependent second member.", dependency_pins: [root] });
  }));
});

test("dependent members can use earlier publication pins within one atomic batch", () => {
  const f = fixture();
  f.atomic(() => {
    const parent = f.append("C-1", { claim_id: "C-1", statement: "First member.", dependency_pins: [] });
    f.append("C-2", { claim_id: "C-2", statement: "Second member.", dependency_pins: [parent] });
  });
  assert.equal((f.db.prepare("SELECT public_seq FROM problems WHERE id = 'P-TEST'").get() as { public_seq: number }).public_seq, 2);
});

test("the exact UTF-8 per-source bound is accepted; plus one is refused", () => {
  const f = fixture();
  const base = JSON.stringify({ claim_id: "C-1", kind: "lemma", statement: "Exact statement 1, version 1.", dependency_pins: [], padding: "" });
  const room = 65536 - Buffer.byteLength(base);
  const exact = f.claim(1, [], { padding: "x".repeat(room) });
  assert.equal((f.db.prepare("SELECT length(CAST(payload_json AS BLOB)) AS n FROM event_content WHERE event_id = ?").get(exact.event_id) as { n: number }).n, 65536);
  assert.equal(f.claim(2, [exact]).version, 1);
  f.refuses(() => f.claim(3, [], { padding: "x".repeat(room + 1) }));
});

test("a newly published dependent cannot reach a non-claim event as a premise", () => {
  const f = fixture();
  const evidence = f.atomic(() => f.append("E-1", { claim_id: "E-1", statement: "Evidence is not a claim.", dependency_pins: [] }, { type: "evidence.created", kind: "evidence" }));
  f.refuses(() => f.claim(2, [evidence]));
});

test("statement revisions cannot publish a fabricated base version in dependency history", () => {
  const f = fixture(); f.claim(1);
  const broken = f.atomic(() => f.append("C-1", { claim_id: "C-1", statement: "Broken lineage.", dependency_pins: [], base_version: 7 }, { version: 2, type: "claim.revised", settle: false }));
  f.refuses(() => f.claim(2, [broken]));
});
