import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { loadProblemRetractions } from "../../src/ledger/retractions.ts";
import {
  readScientificEvidence,
  scientificContentGuards,
} from "../../src/ledger/scientific-checks.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const claim = {
  eventId: "claim-event",
  payloadDigest: "a".repeat(64),
  claimId: "C-1",
  version: 1,
  contentDigest: `sha256:${"b".repeat(64)}`,
  statement: "A precise statement.",
  fellowId: "F-author",
  sponsorId: "sponsor",
  provenance: null,
};

// Real reader and admission SQL with modeled existing tables. This is a unit
// regression, not an enrollment/ledger transaction or deployed D1 integration.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_id TEXT, object_kind TEXT, object_version INTEGER, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE evidence(problem_id TEXT, evidence_id TEXT, author_fellow_id TEXT);
    CREATE TABLE retractions(retraction_id TEXT, problem_id TEXT, seq INTEGER, target_object TEXT,
      retraction_kind TEXT, reason TEXT, author_fellow_id TEXT, created_at TEXT);
    CREATE TABLE scientific_withdrawals(source_event_id TEXT PRIMARY KEY);
    CREATE VIEW artifact_publication_evidence AS SELECT 1 AS old_view;
    INSERT INTO problems VALUES('P-DEMO',3,'active'),('P-OTHER',3,'active');`);
  sql.exec(
    readFileSync(
      new URL("../../../../db/migrations/0072_withdrawn_artifact_evidence.sql", import.meta.url),
      "utf8",
    ),
  );
  const body = JSON.stringify({
    bears_on_kind: "claim",
    bears_on_id: "C-1",
    bears_on_version: 1,
    kind: "argument",
    direction: "supports",
    mode: "confirmatory",
    computed_class: "citation",
    body_md: "The detailed public argument.",
  });
  const hash = digest(body);
  sql
    .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "evidence-event",
      "P-DEMO",
      2,
      "evidence.created",
      "E-1",
      "evidence",
      1,
      hash,
      "F-author",
      "sponsor",
      "session",
      "model",
      "harness",
    );
  sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run("evidence-event", hash, body);
  sql.exec("INSERT INTO evidence VALUES('P-DEMO','E-1','F-author')");
  const db = {
    prepare(text: string) {
      let values: (string | number | null)[] = [];
      return {
        bind(...bound: (string | number | null)[]) {
          values = bound;
          return this;
        },
        async all() {
          return { success: true, results: sql.query(text).all(...values) };
        },
        async first() {
          return sql.query(text).get(...values) ?? null;
        },
        async run() {
          sql.query(text).all(...values);
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
  const reference = { evidence_id: "E-1", digest: `sha256:${hash}` };
  const withdraw = () => sql.exec("INSERT INTO scientific_withdrawals VALUES('evidence-event')");
  function explanation(extra: Record<string, unknown> = {}) {
    const payload = JSON.stringify({
      retraction_id: "R-EXAMPLE",
      target_object: "E-1",
      retraction_kind: "self-corrected",
      reason: "The validated public explanation.",
      ...extra,
    });
    const sha = digest(payload);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "withdrawal-event",
        "P-DEMO",
        3,
        "object.retracted",
        "R-EXAMPLE",
        "retraction",
        1,
        sha,
        "F-author",
        "sponsor",
        "session",
        "model",
        "harness",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run("withdrawal-event", sha, payload);
    sql
      .query("INSERT INTO retractions VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "R-EXAMPLE",
        "P-DEMO",
        3,
        "E-1",
        "self-corrected",
        "RETAINED-PRIVATE-REASON",
        "F-author",
        "2026-09-17T00:00:00.000Z",
      );
  }
  return { sql, db, hash, body, reference, withdraw, explanation };
}
async function using(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}

test("live evidence still resolves and passes its transaction-time guard", () =>
  using(async (f) => {
    assert.equal(
      (await readScientificEvidence(f.db, "P-DEMO", claim, f.reference)).evidenceId,
      "E-1",
    );
    assert.notEqual(
      await scientificContentGuards(f.db, [
        { eventId: "evidence-event", payloadDigest: f.hash },
      ])[0]!.first(),
      null,
    );
  }));
test("directly withdrawn evidence cannot ground a new scientific reference", () =>
  using(async (f) => {
    f.withdraw();
    await assert.rejects(readScientificEvidence(f.db, "P-DEMO", claim, f.reference), /unavailable/);
    assert.equal(
      f.sql
        .query("SELECT payload_json FROM event_content WHERE event_id='evidence-event'")
        .get() !== null,
      true,
    );
  }));
test("withdrawal after a pre-screening read aborts the reference guard", () =>
  using(async (f) => {
    const original = await readScientificEvidence(f.db, "P-DEMO", claim, f.reference);
    f.withdraw();
    await assert.rejects(
      scientificContentGuards(f.db, [original])[0]!.run(),
      /SCIENTIFIC_REFERENCE_CHANGED/,
    );
  }));
test("failed source guard rolls back a surrounding publication transaction", () =>
  using(async (f) => {
    f.withdraw();
    f.sql.exec("BEGIN");
    try {
      f.sql.exec("UPDATE problems SET public_seq=4 WHERE id='P-DEMO'");
      await scientificContentGuards(f.db, [
        { eventId: "evidence-event", payloadDigest: f.hash },
      ])[0]!.run();
      assert.fail("the guard must abort");
    } catch (error) {
      f.sql.exec("ROLLBACK");
      assert.match(String(error), /SCIENTIFIC_REFERENCE_CHANGED/);
    }
    assert.deepEqual(f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get(), {
      public_seq: 3,
    });
  }));
test("unrelated withdrawal does not invalidate another event", () =>
  using(async (f) => {
    f.sql.exec("INSERT INTO scientific_withdrawals VALUES('unrelated')");
    assert.equal(
      (await readScientificEvidence(f.db, "P-DEMO", claim, f.reference)).eventId,
      "evidence-event",
    );
  }));
test("the shared artifact source view excludes withdrawn evidence", () =>
  using(async (f) => {
    assert.equal(f.sql.query("SELECT * FROM artifact_publication_evidence").all().length, 1);
    f.withdraw();
    assert.equal(f.sql.query("SELECT * FROM artifact_publication_evidence").all().length, 0);
    assert.equal(f.sql.query("SELECT * FROM evidence").all().length, 1);
  }));
test("the release-time view observes a withdrawal committed after an earlier read", () =>
  using(async (f) => {
    assert.equal(
      f.sql.query("SELECT evidence_event_id FROM artifact_publication_evidence").all().length,
      1,
    );
    f.withdraw();
    f.sql.exec("BEGIN");
    assert.equal(
      f.sql
        .query(
          "SELECT evidence_event_id FROM artifact_publication_evidence WHERE evidence_event_id='evidence-event'",
        )
        .all().length,
      0,
    );
    f.sql.exec("COMMIT");
  }));
test("artifact source view still respects private visibility and redaction", () =>
  using(async (f) => {
    f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
    assert.equal(f.sql.query("SELECT * FROM artifact_publication_evidence").all().length, 0);
    f.sql.exec(
      "UPDATE problems SET status='active' WHERE id='P-DEMO'; UPDATE event_content SET redacted_at='hidden'",
    );
    assert.equal(f.sql.query("SELECT * FROM artifact_publication_evidence").all().length, 0);
  }));
test("retraction explanation comes from exact public event bytes, never the retained projection", () =>
  using(async (f) => {
    f.explanation();
    const result = await loadProblemRetractions(f.db, "P-DEMO");
    assert.equal(result.retractions[0]?.reason, "The validated public explanation.");
    assert.ok(!JSON.stringify(result).includes("RETAINED-PRIVATE-REASON"));
  }));
test("redaction hides the explanation without deleting the withdrawal", () =>
  using(async (f) => {
    f.withdraw();
    f.explanation();
    f.sql.exec("UPDATE event_content SET redacted_at='hidden' WHERE event_id='withdrawal-event'");
    const result = await loadProblemRetractions(f.db, "P-DEMO");
    assert.deepEqual(result.retractions, []);
    assert.equal(result.omitted.length, 1);
    assert.equal(f.sql.query("SELECT * FROM scientific_withdrawals").all().length, 1);
  }));
test("tampered explanation bytes cannot use an unchanged digest label", () =>
  using(async (f) => {
    f.explanation();
    f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='withdrawal-event'");
    const result = await loadProblemRetractions(f.db, "P-DEMO");
    assert.deepEqual(result.retractions, []);
    assert.equal(result.omitted.length, 1);
  }));
test("contradictory target metadata is an omission rather than an invented correction", () =>
  using(async (f) => {
    f.explanation({ target_object: "E-other" });
    const result = await loadProblemRetractions(f.db, "P-DEMO");
    assert.deepEqual(result.retractions, []);
    assert.equal(result.omitted.length, 1);
  }));
test("private and absent problems have the same retraction-reader result", () =>
  using(async (f) => {
    f.explanation();
    f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
    assert.deepEqual(
      await loadProblemRetractions(f.db, "P-DEMO"),
      await loadProblemRetractions(f.db, "P-MISSING"),
    );
  }));
test("forged retraction attribution cannot republish a retained reason", () =>
  using(async (f) => {
    f.explanation();
    f.sql.exec("UPDATE retractions SET author_fellow_id='F-impostor'");
    assert.deepEqual((await loadProblemRetractions(f.db, "P-DEMO")).retractions, []);
  }));
