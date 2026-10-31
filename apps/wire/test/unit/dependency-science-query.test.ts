import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  DEPENDENCY_SCIENCE_ITEM_BYTES,
  DEPENDENCY_SCIENCE_ROW_LIMIT,
  DEPENDENCY_SCIENCE_TOTAL_BYTES,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../../src/ledger/claim-dependency-assessment";

import { installEmptyDirectiveDisclosureTables } from "../support/directive-disclosure-read.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const digest = async (body: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, object_id TEXT,
      object_version INTEGER, type TEXT, object_kind TEXT, seq INTEGER,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT,
      actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT, created_at TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE claim_versions (problem_id TEXT, claim_id TEXT, version INTEGER,
      content_digest TEXT, kind TEXT, statement TEXT, falsifier TEXT, PRIMARY KEY (problem_id, claim_id, version));
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE evidence (evidence_id TEXT, problem_id TEXT, source_event_id TEXT, source_seq INTEGER,
      bears_on_kind TEXT, bears_on_id TEXT, bears_on_version INTEGER, direction TEXT);
    CREATE TABLE reviews (review_id TEXT, problem_id TEXT, source_event_id TEXT, source_seq INTEGER,
      target_claim_id TEXT, target_version INTEGER, verdict TEXT, capable_of_failure TEXT);
    CREATE TABLE retractions (problem_id TEXT, retraction_id TEXT, target_object TEXT, seq INTEGER, author_fellow_id TEXT);
    CREATE TABLE scientific_withdrawals (event_id TEXT, event_sha256 TEXT, problem_id TEXT,
      retraction_id TEXT, target_object TEXT, fellow_id TEXT, seq INTEGER, source_event_id TEXT,
      claim_version INTEGER, claim_id TEXT, source_sha256 TEXT, target_kind TEXT);
    INSERT INTO problems VALUES ('P-READ', 'active', 10000), ('P-OTHER', 'active', 10000);
  `);
  installEmptyDirectiveDisclosureTables(db);
  let seq = 0;
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...args: (string | number)[]) {
          return { all: async () => ({ results: db.prepare(sql).all(...args) }) };
        },
      };
    },
  } as unknown as D1Database;
  const addEvent = async (
    kind: string,
    type: string,
    object: string,
    version: number,
    payload: Record<string, unknown>,
    problem = "P-READ",
  ) => {
    const event = `EV-${++seq}`,
      body = JSON.stringify(payload),
      hash = await digest(body);
    db.prepare(
      "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'F-A', 'S-A', 'SESSION', 'family', 'harness', '2026-10-01T00:00:00.000Z')",
    ).run(event, problem, object, version, type, kind, seq, hash);
    db.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(event, hash, body);
    return { event, hash, seq };
  };
  const claim = async (id: number, pins: unknown[] = [], version = 1, problem = "P-READ") => {
    const claim_id = `C-${id}`,
      statement = `Statement ${id} version ${version}`;
    const e = await addEvent(
      "claim",
      version === 1 ? "claim.created" : "claim.revised",
      claim_id,
      version,
      {
        claim_id,
        statement,
        kind: "lemma",
        dependency_pins: pins,
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      problem,
    );
    const content_digest = `sha256:${await digest(statement)}`;
    db.prepare(
      "INSERT INTO claim_versions VALUES (?, ?, ?, ?, 'lemma', ?, 'A counterexample')",
    ).run(problem, claim_id, version, content_digest, statement);
    return { claim_id, version, event_id: e.event, payload_digest: e.hash, content_digest };
  };
  const evidence = async (claimId = "C-1", version = 1, body = "Evidence", problem = "P-READ") => {
    const id = `E-${seq + 1}`;
    const e = await addEvent(
      "evidence",
      "evidence.created",
      id,
      1,
      {
        bears_on_kind: "claim",
        bears_on_id: claimId,
        bears_on_version: version,
        kind: "computation",
        direction: "supports",
        mode: "confirmatory",
        computed_class: "computation",
        body_md: body,
      },
      problem,
    );
    db.prepare("INSERT INTO evidence VALUES (?, ?, ?, ?, 'claim', ?, ?, 'supports')").run(
      id,
      problem,
      e.event,
      e.seq,
      claimId,
      version,
    );
    return e;
  };
  const read = async (target = "C-2@1", cursor = seq) =>
    (await prepareDependencyAssessment(d1, "P-READ", cursor, target).all<DependencyScientificRow>())
      .results;
  const chain = async () => claim(2, [await claim(1)]);
  return { db, d1, claim, evidence, addEvent, read, chain };
}

test("science query reads both root and exact pinned premise evidence", async () => {
  const f = fixture();
  await f.chain();
  const e = await f.evidence();
  const rows = await f.read();
  assert.deepEqual(
    rows.map((r) => r.object_id),
    ["C-1", "C-2", "E-3"],
  );
  assert.equal(rows.at(-1)?.event_id, e.event);
  assert.equal(rows.at(-1)?.claim_id, "C-1");
  assert.ok(rows.every((r) => r.scan_complete === 1 && r.problem_id === "P-READ"));
});

test("science query observes the cursor and independent publication boundary", async () => {
  const f = fixture();
  await f.chain();
  await f.evidence();
  assert.equal((await f.read("C-2@1", 2)).length, 2);
  f.db.exec("UPDATE problems SET public_seq = 2 WHERE id = 'P-READ'");
  assert.equal((await f.read("C-2@1", 1000)).length, 2);
});

test("science query never borrows another problem's evidence or later version", async () => {
  const f = fixture();
  await f.chain();
  await f.claim(1, [], 2);
  await f.evidence("C-1", 2);
  await f.claim(1, [], 1, "P-OTHER");
  await f.evidence("C-1", 1, "FOREIGN", "P-OTHER");
  const rows = await f.read();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.latest_version, 2);
  assert.ok(rows.every((r) => r.target_version === 1));
  assert.ok(!JSON.stringify(rows).includes("FOREIGN"));
  assert.equal((await f.read("C-2@1", 2))[0]?.latest_version, 1);
});

test("science query withholds redacted evidence bytes without dropping its envelope", async () => {
  const f = fixture();
  await f.chain();
  const e = await f.evidence();
  f.db.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(e.event);
  const rows = await f.read();
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1)?.payload_json, null);
});

test("science query withholds missing and digest-detached content", async () => {
  const f = fixture();
  await f.chain();
  const e = await f.evidence();
  f.db.prepare("UPDATE event_content SET payload_sha256='detached' WHERE event_id=?").run(e.event);
  assert.equal((await f.read()).at(-1)?.payload_json, null);
});

test("science query excludes hidden intermediate branches and restores current controls", async () => {
  const f = fixture();
  const a = await f.claim(1),
    b = await f.claim(2, [a]);
  await f.claim(3, [b]);
  await f.evidence("C-1", 1, "LEAF-PRIVATE");
  f.db.exec("INSERT INTO content_controls VALUES ('P-READ', 'C-2', 'hidden', 1)");
  assert.deepEqual(
    (await f.read("C-3@1")).map((r) => r.claim_id),
    ["C-3"],
  );
  f.db.exec("INSERT INTO content_controls VALUES ('P-READ', 'C-2', 'public', 2)");
  assert.ok((await f.read("C-3@1")).some((r) => r.claim_id === "C-1"));
});

for (const kind of ["problem", "C-2"]) {
  test(`science query discloses no bodies for hidden ${kind}`, async () => {
    const f = fixture();
    await f.chain();
    f.db.prepare("INSERT INTO content_controls VALUES ('P-READ', ?, 'hidden', 1)").run(kind);
    assert.equal((await f.read()).length, 0);
  });
}

test("science query excludes private-draft data", async () => {
  const f = fixture();
  await f.chain();
  f.db.exec("UPDATE problems SET status='private-draft' WHERE id='P-READ'");
  assert.deepEqual(await f.read(), []);
});

test("science query enforces UTF-8 item size before returning payload bytes", async () => {
  const f = fixture();
  await f.chain();
  await f.evidence("C-1", 1, "é".repeat(33000));
  const rows = await f.read();
  assert.equal(rows.at(-1)?.payload_json, null);
  assert.equal(rows.length, 3);
});

test("science query accepts the exact per-item byte limit and withholds plus one", async () => {
  const f = fixture();
  await f.chain();
  const overhead = new TextEncoder().encode(
    JSON.stringify({
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "computation",
      direction: "supports",
      mode: "confirmatory",
      computed_class: "computation",
      body_md: "",
    }),
  ).length;
  await f.evidence("C-1", 1, "x".repeat(DEPENDENCY_SCIENCE_ITEM_BYTES - overhead));
  let rows = await f.read();
  assert.equal(
    new TextEncoder().encode(rows.at(-1)?.payload_json ?? "").length,
    DEPENDENCY_SCIENCE_ITEM_BYTES,
  );
  await f.evidence("C-1", 1, "x".repeat(DEPENDENCY_SCIENCE_ITEM_BYTES - overhead + 1));
  rows = await f.read();
  assert.equal(rows.at(-1)?.payload_json, null);
});

test("science query caps aggregate returned bytes and retains omission envelopes", async () => {
  const f = fixture();
  await f.chain();
  for (let n = 0; n < 8; n++) await f.evidence("C-1", 1, "x".repeat(60000));
  const rows = await f.read();
  const bytes = rows.reduce(
    (sum, row) => sum + new TextEncoder().encode(row.payload_json ?? "").length,
    0,
  );
  assert.ok(bytes <= DEPENDENCY_SCIENCE_TOTAL_BYTES);
  assert.ok(rows.some((r) => r.payload_json === null));
  assert.equal(rows.length, 10);
});

test("science query has an exact row limit plus one body-free lookahead", async () => {
  const f = fixture();
  await f.chain();
  for (let n = 0; n < DEPENDENCY_SCIENCE_ROW_LIMIT - 2; n++) await f.evidence();
  let rows = await f.read();
  assert.equal(rows.length, DEPENDENCY_SCIENCE_ROW_LIMIT);
  assert.ok(rows.every((r) => r.scan_complete === 1));
  await f.evidence();
  rows = await f.read();
  assert.equal(rows.length, DEPENDENCY_SCIENCE_ROW_LIMIT + 1);
  assert.ok(rows.every((r) => r.scan_complete === 0));
  assert.equal(rows.at(-1)?.payload_json, null);
});

test("science query binds withdrawal records to the target claim and version", async () => {
  const f = fixture();
  await f.chain();
  const ev = await f.evidence();
  const re = await f.addEvent("retraction", "object.retracted", "RT-1", 1, {
    target_object: "E-3",
  });
  f.db.prepare("INSERT INTO retractions VALUES ('P-READ','RT-1','E-3',?,'F-A')").run(re.seq);
  f.db
    .prepare(
      "INSERT INTO scientific_withdrawals VALUES (?,?,'P-READ','RT-1','E-3','F-A',?,?,1,'C-1',?,'evidence')",
    )
    .run(re.event, re.hash, re.seq, ev.event, ev.hash);
  const row = (await f.read()).at(-1)!;
  assert.equal(row.type, "object.retracted");
  assert.equal(row.claim_id, "C-1");
  assert.equal(row.target_version, 1);
  assert.equal(row.withdrawn_event_id, ev.event);
});

test("science query does not turn a detached projection into evidence", async () => {
  const f = fixture();
  await f.chain();
  await f.evidence();
  f.db.exec("UPDATE evidence SET source_seq=999");
  const rows = await f.read();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.scan_complete === 0));
});

for (const target of ["C-1", "C-1@0", "C-1@1\n", "C-1@9007199254740992"]) {
  test(`science query refuses a noncanonical exact target ${JSON.stringify(target)}`, () => {
    const f = fixture();
    assert.throws(() => prepareDependencyAssessment(f.d1, "P-READ", 1, target));
  });
}

test("science query leaves SQL failures visible rather than fabricating an empty standing", async () => {
  const f = fixture();
  await f.chain();
  f.db.exec("ALTER TABLE reviews RENAME TO missing_reviews");
  await assert.rejects(f.read());
});
