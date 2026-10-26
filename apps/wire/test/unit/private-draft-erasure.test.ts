import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import { declareArtifact, readArtifactManifest } from "../../src/krater/artifact-store.ts";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import {
  applyDeletionJournal,
  createRetentionControlRecord,
  hardDeletePrivateDraft,
  privateDraftDeletionStatements,
  readDeletionJournalRecords,
  serializeDeletionJournal,
} from "../../src/krater/retention.ts";
import { suspendSponsor } from "../../src/moderation/sponsor-suspension.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const SPONSOR = "usr_draft_erasure";
const PROBLEM = "P-ERASURE";
const SESSION = `S-${"A".repeat(26)}`;
const CASE = `QC-${"A".repeat(26)}`;
type Value = string | number | null;

// All shipped SQL migrations and legal enrollment/upload commands on SQLite.
// This is a transaction unit test, not a Workerd or R2 erasure claim.
function database() {
  const sql = new Database(":memory:");
  const migrations = new URL("../../../../db/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sql.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const prepare = (query: string) => {
    const bound = (...values: Value[]) => ({
      async first() {
        return sql.query(query).get(...values) ?? null;
      },
      async all() {
        return { results: sql.query(query).all(...values) };
      },
      async run() {
        if (/^\s*SELECT\b/i.test(query))
          return { results: sql.query(query).all(...values), meta: { changes: 0 } };
        const result = sql.query(query).run(...values);
        return { results: [], meta: { changes: result.changes } };
      },
    });
    return { ...bound(), bind: bound };
  };
  const db = {
    prepare,
    async batch(statements: { run(): Promise<unknown> }[]) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sql, db };
}

async function fixture() {
  const { sql, db } = database();
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(db),
    clock: { now: () => NOW },
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  });
  const principal = { type: "sponsor" as const, sponsorId: SPONSOR };
  await service.bootstrapSponsor(principal);
  const grant = await service.mint(principal, { requested_scopes: ["upload-artifacts", "review"] });
  const claim = await service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "private-erasure-fellow",
    model: "fixture/model",
    harness: "curl",
  });
  await service.decide(principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: NOW / 1000,
  });
  const poll = await service.poll({ flow_handle: claim.flowHandle });
  if (!("token" in poll)) throw new Error("Fixture did not issue a token");
  const actor = await service.credentialBinding(poll.token);
  if (!actor) throw new Error("Fixture token was not active");
  sql
    .query(`INSERT INTO problems(id,status,sponsor_id,created_by_fellow_id,title,
    resolution_summary,resolution_no_claim_boundary,famous_guardrail,areas,created_at,updated_at)
    VALUES (?,'private-draft',?,?,'Secret title','Secret resolution','Secret boundary','Secret guardrail','["Secret area"]',?,?)`)
    .run(PROBLEM, SPONSOR, actor.fellowId, ISO, ISO);
  sql
    .query(`INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
    VALUES (?,1,'Secret statement','hash','Secret falsifier','Secret motivation',?)`)
    .run(PROBLEM, ISO);
  sql
    .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at,handback,close_keep_json,close_discard_json)
    VALUES (?,?,?,?,?,?,'Secret handback','["Secret kept"]','["Secret discarded"]')`)
    .run(SESSION, actor.fellowId, PROBLEM, ISO, ISO, new Date(NOW + 3600000).toISOString());
  sql
    .query("INSERT INTO problem_memberships VALUES (?,?,'contributor',?)")
    .run(PROBLEM, actor.fellowId, ISO);
  sql.query("INSERT INTO problem_stewards VALUES (?,?,1,?)").run(PROBLEM, SPONSOR, ISO);
  sql.query("INSERT INTO problem_follows VALUES (?,?,?)").run(SPONSOR, PROBLEM, NOW);
  sql
    .query(`INSERT INTO workshop_objects(workshop_id,problem_id,fellow_id,session_id,workshop_seq,type,title,body_md,created_at)
    VALUES ('W-ERASURE',?,?,?,1,'note','Secret workshop','Secret work product',?)`)
    .run(PROBLEM, actor.fellowId, SESSION, ISO);
  sql
    .query(`INSERT INTO workshop_revisions(workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,created_at)
    VALUES ('W-ERASURE',1,?,?,?,'note','Secret old title','Secret old revision',?)`)
    .run(PROBLEM, actor.fellowId, SESSION, ISO);
  sql
    .query(`INSERT INTO fellow_inbox_notices(id,fellow_id,problem_id,notice_type,seq,title,detail,created_at)
    VALUES ('NOTICE-ERASURE',?,?,'directive',1,'Secret directive title','Secret directive text',?)`)
    .run(actor.fellowId, PROBLEM, NOW);
  sql
    .query(`INSERT INTO sponsor_directives(id,sponsor_id,fellow_id,problem_id,verb,body,notice_id,idempotency_key,request_digest,created_at)
    VALUES ('DIRECTIVE-ERASURE',?,?,?,'focus','Secret directive text','NOTICE-ERASURE','directive-key',?,?)`)
    .run(SPONSOR, actor.fellowId, PROBLEM, "a".repeat(64), NOW);
  sql
    .query(`INSERT INTO screening_cases(case_id,problem_id,fellow_id,sponsor_id,route,input_digest,context_digest,
    candidate_json,contextual_input_json,coarse_category,outcome,decision_path,provider_status,model_version,policy_version,configuration_digest,created_at)
    VALUES (?,?,?,?,'promote',?,?,'{"statement":"Secret candidate"}','{"context":"Secret context"}',
      'injection','quarantine','model','ok','model','policy',?,?)`)
    .run(
      CASE,
      PROBLEM,
      actor.fellowId,
      SPONSOR,
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      ISO,
    );
  const upload = await declareArtifact(
    db,
    {
      async seal(value) {
        return { ciphertext: value, initializationVector: "fixture" };
      },
      async open(value) {
        return value.ciphertext;
      },
    },
    {
      accountId: "a".repeat(32),
      bucket: "private-artifacts",
      accessKeyId: "b".repeat(32),
      secretAccessKey: "c".repeat(64),
      sponsorDailyBytes: 1024,
      fellowDailyManifests: 10,
    },
    actor,
    { sessionId: SESSION, sha256: "e".repeat(64), size: 200, encoding: "text" },
    "upload-erasure",
    () => NOW,
  );
  return { sql, db, service, principal, actor, upload };
}

for (const route of ["draft", "account"] as const) {
  test(`${route} deletion erases draft content, preserves audit/quota evidence, and prevents revival`, async () => {
    const f = await fixture();
    const beforeUpload = f.sql.query("SELECT * FROM artifact_uploads").all();
    if (route === "draft") {
      const result = await hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR, { now: ISO });
      expect(result.rowsDeleted).toMatchObject({
        problem: 0,
        workshopObjects: 1,
        workshopRevisions: 1,
        sessions: 0,
        statementVersions: 1,
        memberships: 1,
        stewards: 1,
      });
      expect(result.receipt.privateDraftContent).toBe(
        "erased-with-audit-and-quota-evidence-retained",
      );
    } else {
      const preview = await f.service.previewDeleteSponsorAccount(f.principal);
      const result = await f.service.deleteSponsorAccount(
        f.principal,
        {
          confirm: "delete-sponsor-account-and-revoke-all-fellows",
          expected_preview: preview.review,
          step_up_authenticated_at: NOW / 1000,
        },
        { idempotencyKey: "account-erasure" },
      );
      expect(result.private_drafts_deleted_count).toBe(1);
    }
    expect(
      f.sql
        .query(`SELECT status,public_seq,title,sponsor_id,created_by_fellow_id,areas,
      resolution_summary,resolution_no_claim_boundary,famous_guardrail,admission_mode FROM problems WHERE id = ?`)
        .get(PROBLEM),
    ).toEqual({
      status: "private-draft",
      public_seq: 0,
      title: "",
      sponsor_id: null,
      created_by_fellow_id: null,
      areas: "[]",
      resolution_summary: null,
      resolution_no_claim_boundary: null,
      famous_guardrail: null,
      admission_mode: "archived-read-only",
    });
    for (const table of [
      "workshop_objects",
      "workshop_revisions",
      "problem_statement_versions",
      "problem_memberships",
      "problem_stewards",
      "problem_follows",
    ]) {
      expect(
        f.sql.query(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`).get(PROBLEM),
      ).toEqual({ n: 0 });
    }
    expect(f.sql.query("SELECT body,request_digest FROM sponsor_directives").get()).toEqual({
      body: "[Private draft erased]",
      request_digest: "a".repeat(64),
    });
    expect(f.sql.query("SELECT title,detail FROM fellow_inbox_notices").get()).toEqual({
      title: "Private draft erased",
      detail: null,
    });
    expect(
      f.sql
        .query(
          "SELECT state,candidate_json,contextual_input_json,input_digest FROM screening_cases",
        )
        .get(),
    ).toEqual({
      state: "superseded",
      candidate_json: '{"erased":true}',
      contextual_input_json: null,
      input_digest: "b".repeat(64),
    });
    expect(
      f.sql
        .query("SELECT closed_at,handback,close_keep_json,close_discard_json FROM sessions")
        .get(),
    ).toEqual({ closed_at: ISO, handback: null, close_keep_json: null, close_discard_json: null });
    expect(f.sql.query("SELECT * FROM artifact_uploads").all()).toEqual(beforeUpload);
    expect(f.sql.query("SELECT SUM(size_bytes) AS bytes FROM artifact_uploads").get()).toEqual({
      bytes: 200,
    });
    expect(f.sql.query("SELECT state FROM artifact_upload_events").all()).toEqual([
      { state: "presigned" },
    ]);
    await expect(readArtifactManifest(f.db, f.actor, f.upload.upload_id, NOW)).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      f.sql.query("SELECT id FROM problems WHERE status <> 'private-draft' AND unlisted = 0").all(),
    ).toEqual([]);
    for (const query of [
      "UPDATE problems SET status='active' WHERE id='P-ERASURE'",
      "UPDATE problems SET title='Reintroduced content' WHERE id='P-ERASURE'",
      `UPDATE sessions SET closed_at=NULL WHERE session_id='${SESSION}'`,
      `UPDATE sessions SET handback='Reintroduced content' WHERE session_id='${SESSION}'`,
      "UPDATE sponsor_directives SET body='Reintroduced content'",
      "UPDATE screening_cases SET candidate_json='{}'",
      "UPDATE fellow_inbox_notices SET detail='Reintroduced content'",
      "DELETE FROM private_draft_erasures",
      "DELETE FROM artifact_uploads",
      "DELETE FROM artifact_upload_events",
      "DELETE FROM screening_cases",
    ])
      expect(() => f.sql.exec(query)).toThrow();
    expect(() =>
      f.sql
        .query("INSERT INTO problem_memberships VALUES (?,?,'contributor',?)")
        .run(PROBLEM, f.actor.fellowId, ISO),
    ).toThrow("PRIVATE_DRAFT_ERASED");
    expect(() =>
      f.sql
        .query(
          "INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at) VALUES ('NEW',?,?,?,?,?)",
        )
        .run(f.actor.fellowId, PROBLEM, ISO, ISO, ISO),
    ).toThrow();
    f.sql.close();
  });
}

test("erasure is journal-bound, refuses public/foreign targets, and rolls back partial failure", async () => {
  const f = await fixture();
  expect(() =>
    f.sql.query("INSERT INTO private_draft_erasures VALUES (?, 'RC-missing', ?)").run(PROBLEM, ISO),
  ).toThrow("PRIVATE_DRAFT_ERASURE_NOT_AUTHORIZED");
  const wrong = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: PROBLEM,
    targetType: "problem",
    issuedAt: ISO,
    payload: { sponsor_id: "usr_foreign" },
  });
  await expect(f.db.batch(privateDraftDeletionStatements(f.db, wrong))).rejects.toThrow(
    "PRIVATE_DRAFT_ERASURE_NOT_AUTHORIZED",
  );
  expect(await readDeletionJournalRecords(f.db)).toEqual([]);
  f.sql.exec(
    "CREATE TRIGGER planted_erasure_failure BEFORE UPDATE ON screening_cases BEGIN SELECT RAISE(ABORT,'planted erasure failure'); END",
  );
  await expect(hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR, { now: ISO })).rejects.toThrow(
    "planted erasure failure",
  );
  expect(f.sql.query("SELECT title FROM problems").get()).toEqual({ title: "Secret title" });
  expect(f.sql.query("SELECT body FROM sponsor_directives").get()).toEqual({
    body: "Secret directive text",
  });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM workshop_objects").get()).toEqual({ n: 1 });
  expect(await readDeletionJournalRecords(f.db)).toEqual([]);
  expect(f.sql.query("SELECT * FROM private_draft_erasures").all()).toEqual([]);
  f.sql.exec("DROP TRIGGER planted_erasure_failure");
  f.sql.query("UPDATE problems SET status='active' WHERE id=?").run(PROBLEM);
  const published = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: PROBLEM,
    targetType: "problem",
    issuedAt: ISO,
    payload: { sponsor_id: SPONSOR },
  });
  await expect(f.db.batch(privateDraftDeletionStatements(f.db, published))).rejects.toThrow(
    "PRIVATE_DRAFT_ERASURE_NOT_AUTHORIZED",
  );
  expect(() =>
    f.sql.exec("UPDATE sponsor_directives SET body='changed public instruction'"),
  ).toThrow("SPONSOR_DIRECTIVE_IMMUTABLE");
  expect(() => f.sql.exec("DELETE FROM problem_statement_versions")).toThrow(
    "PROBLEM_STATEMENT_VERSION_IMMUTABLE",
  );
  f.sql.close();
});

test("signed restore erases the restored content and fences deleted IDs absent from older snapshots", async () => {
  const f = await fixture();
  const erased = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: PROBLEM,
    targetType: "problem",
    issuedAt: ISO,
    payload: { sponsor_id: SPONSOR },
  });
  const absent = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: "P-ABSENT",
    targetType: "problem",
    issuedAt: ISO,
    payload: { sponsor_id: SPONSOR },
  });
  const key = await checkpointSigningKey(
    JSON.stringify({ kid: "erasure-test", seedHex: "11".repeat(32) }),
  );
  if (!key) throw new Error("Signing fixture failed");
  const options = {
    db: f.db,
    targetIdentifier: "scratch_erasure_restore",
    deletionJournalNdjson: await serializeDeletionJournal([erased, absent], ISO, key),
    verifyKeys: [{ kid: key.kid, publicKeyHex: key.publicKeyHex }],
  };
  expect((await applyDeletionJournal(options)).appliedControlsCount).toBe(2);
  expect((await applyDeletionJournal(options)).appliedControlsCount).toBe(2);
  expect(
    f.sql.query("SELECT problem_id FROM private_draft_erasures ORDER BY problem_id").all(),
  ).toEqual([{ problem_id: "P-ABSENT" }, { problem_id: PROBLEM }]);
  expect(() =>
    f.sql
      .query("INSERT INTO problems(id,created_at,updated_at) VALUES ('P-ABSENT',?,?)")
      .run(ISO, ISO),
  ).toThrow("PRIVATE_DRAFT_ERASED");
  expect(f.sql.query("SELECT candidate_json FROM screening_cases").get()).toEqual({
    candidate_json: '{"erased":true}',
  });
  expect((await readDeletionJournalRecords(f.db)).length).toBe(2);
  f.sql.close();
});

test("suspended sponsor draft erasure retains the reviewed decision and suspension evidence", async () => {
  const f = await fixture();
  f.sql
    .query(`UPDATE screening_cases SET state='rejected',decided_at=?,decided_by='usr_operator',
    decision_reason='Reviewed decision retained for accountability' WHERE case_id=?`)
    .run(ISO, CASE);
  await suspendSponsor(
    f.db,
    SPONSOR,
    "usr_operator",
    {
      sponsor_id: SPONSOR,
      expected_revision: 0,
      reviewed_case_id: CASE,
      basis: "egregious-reviewed-case",
      reason: "Reviewed suspension remains in force",
      step_up_authenticated_at: NOW / 1000,
    },
    "suspend-erasure",
    NOW,
  );
  const evidence = f.sql.query("SELECT * FROM sponsor_suspension_events").all();
  const operator = f.sql.query("SELECT * FROM operator_audit").all();
  await hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR, { now: ISO });
  expect(f.sql.query("SELECT * FROM sponsor_suspension_events").all()).toEqual(evidence);
  expect(f.sql.query("SELECT * FROM operator_audit").all()).toEqual(operator);
  expect(
    f.sql
      .query("SELECT state,decided_by,decision_reason,candidate_json FROM screening_cases")
      .get(),
  ).toEqual({
    state: "rejected",
    decided_by: "usr_operator",
    decision_reason: "Reviewed decision retained for accountability",
    candidate_json: '{"erased":true}',
  });
  expect(f.sql.query("SELECT handback FROM sessions").get()).toEqual({ handback: null });
  expect(() =>
    f.sql.exec("UPDATE screening_cases SET decision_reason='Changed evidence after erasure'"),
  ).toThrow("SCREENING_CASE_DECIDED_OR_BINDING_IMMUTABLE");
  expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  f.sql.close();
});
