import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { iso, NOW, SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture = ReturnType<typeof withdrawalFixture>;
type Row = Record<string, string | number | null>;

const migration = readFileSync(
  new URL("../../../../db/migrations/0105_hypothesis_evidence_withdrawals.sql", import.meta.url),
  "utf8",
);

function rows(f: Fixture, table: string): Row[] {
  return f.sql.query(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[];
}

function dependentDefinitions(f: Fixture) {
  return f.sql
    .query(`SELECT type, name, sql FROM sqlite_schema WHERE name IN (
      'artifact_publication_evidence', 'hypothesis_kill_admission_before_settlement'
    ) ORDER BY name`)
    .all();
}

function history(f: Fixture) {
  return Object.fromEntries(
    [
      "events",
      "event_content",
      "retractions",
      "public_cursor",
      "problems",
      "public_write_attempt_reservations",
      "screening_publications",
    ].map((table) => [table, rows(f, table)]),
  );
}

/** Seed the old shape through its real 0071 admission trigger. Parent identity,
 * ledger and screening ports are modeled by the shared unit fixture; this is
 * a migration-preservation test, not a claim of real D1 runtime coverage. */
async function legacyCorrection(f: Fixture, kind: "review" | "evidence") {
  const source = f.source(kind, kind === "review" ? "R-LEGACY" : "E-LEGACY");
  const route = `/v1/sessions/${SESSION}/${kind === "review" ? "reviews" : "evidence"}/${source.id}/retract`;
  const keyHash = sha(`legacy-${kind}`);
  const requestDigest = sha(JSON.stringify({ route, request: source.request }));
  const reservation = await f.options.reserve({
    fellowId: f.actor.fellowId,
    sponsorId: f.actor.sponsorId,
    problemId: "P-DEMO",
    sessionId: SESSION,
    route,
    idempotencyKey: keyHash,
    requestDigest,
    now: NOW,
  });
  const retractionId = `R-CORRECTION-${kind.toUpperCase()}`;
  const event = f.append(`E-correction-${kind}`, "object.retracted", "retraction", retractionId, {
    retraction_id: retractionId,
    target_kind: kind,
    target_object: source.id,
    target_event_id: source.event.id,
    target_digest: source.request.source_digest,
    claim_id: "C-1",
    claim_version: 1,
    retraction_kind: "self-corrected",
    reason: source.request.reason,
  });
  f.sql
    .query("UPDATE events SET writer_credential_id = ? WHERE id = ?")
    .run(f.actor.credentialId, event.id);
  f.sql
    .query(`INSERT INTO retractions (
      problem_id, retraction_id, seq, target_object, retraction_kind, reason,
      author_fellow_id, created_at
    ) VALUES ('P-DEMO', ?, ?, ?, 'self-corrected', ?, ?, ?)`)
    .run(retractionId, event.seq, source.id, source.request.reason, f.actor.fellowId, iso());
  const bodyDigest = `sha256:${sha(`screen-body-${kind}`)}`;
  const contextDigest = `sha256:${sha("screen-context")}`;
  const row: Row = {
    event_id: event.id,
    event_sha256: event.digest,
    problem_id: "P-DEMO",
    retraction_id: retractionId,
    seq: event.seq,
    target_kind: kind,
    target_object: source.id,
    source_event_id: source.event.id,
    source_sha256: source.event.digest,
    claim_id: "C-1",
    claim_version: 1,
    fellow_id: f.actor.fellowId,
    sponsor_id: f.actor.sponsorId,
    credential_id: f.actor.credentialId,
    session_id: SESSION,
    route,
    key_hash: keyHash,
    request_digest: requestDigest,
    reservation_id: reservation,
    screen_body_digest: bodyDigest,
    screen_context_digest: contextDigest,
    screen_receipt_json: JSON.stringify({
      decision: "pass",
      provider_status: "ok",
      evaluated_body_digest: bodyDigest,
      evaluated_context_digest: contextDigest,
    }),
    created_at: NOW,
  };
  f.sql
    .query(`INSERT INTO scientific_withdrawals (${Object.keys(row).join(",")})
      VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`)
    .run(...Object.values(row));
  f.sql
    .query(`UPDATE public_write_attempt_reservations
      SET status = 'settled_published', settled_at = ? WHERE reservation_id = ?`)
    .run(NOW, reservation);
}

function upgrade(f: Fixture, lateFailure = false) {
  f.sql.exec("BEGIN");
  try {
    f.sql.exec(migration);
    if (lateFailure) f.sql.exec("INSERT INTO public_cursor(singleton, cursor) VALUES (1, 999999)");
    f.sql.exec("COMMIT");
  } catch (error) {
    f.sql.exec("ROLLBACK");
    throw error;
  }
}

test("hypothesis withdrawal migration preserves every legacy correction byte and its readers", async () => {
  const f = withdrawalFixture({ hypothesisMigration: false });
  try {
    await legacyCorrection(f, "review");
    await legacyCorrection(f, "evidence");
    const original = rows(f, "scientific_withdrawals");
    const originalHistory = history(f);
    const dependencies = dependentDefinitions(f);
    assert.equal(original.length, 2);
    assert.equal(dependencies.length, 2);
    assert.equal(rows(f, "artifact_publication_evidence").length, 0);
    // Historical corrections survive even after their original grant expires.
    f.sql.query("UPDATE fellow_tokens SET revoked_at = ?").run(NOW + 1);
    upgrade(f);
    const upgraded = rows(f, "scientific_withdrawals");
    assert.deepEqual(
      upgraded.map(({ hypothesis_id, ...row }) => {
        assert.equal(hypothesis_id, null);
        return row;
      }),
      original,
    );
    assert.deepEqual(history(f), originalHistory);
    assert.deepEqual(dependentDefinitions(f), dependencies);
    assert.equal(rows(f, "artifact_publication_evidence").length, 0);
    assert.deepEqual(f.sql.query("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(f.sql.query("PRAGMA foreign_keys").get(), { foreign_keys: 1 });
    assert.throws(
      () => f.sql.exec("UPDATE scientific_withdrawals SET claim_version = 2"),
      /SCIENTIFIC_WITHDRAWAL_IMMUTABLE/,
    );
    assert.throws(
      () => f.sql.exec("DELETE FROM scientific_withdrawals"),
      /SCIENTIFIC_WITHDRAWAL_IMMUTABLE/,
    );
    assert.deepEqual(rows(f, "scientific_withdrawals"), upgraded);
  } finally {
    f.close();
  }
});

test("late migration failure restores the original correction schema and all durable history", async () => {
  const f = withdrawalFixture({ hypothesisMigration: false });
  try {
    await legacyCorrection(f, "review");
    await legacyCorrection(f, "evidence");
    const original = rows(f, "scientific_withdrawals");
    const originalHistory = history(f);
    const schema = f.sql
      .query("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    assert.throws(() => upgrade(f, true), /UNIQUE constraint failed/);
    assert.deepEqual(rows(f, "scientific_withdrawals"), original);
    assert.deepEqual(history(f), originalHistory);
    assert.deepEqual(
      f.sql.query("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
      schema,
    );
    assert.deepEqual(f.sql.query("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.close();
  }
});
