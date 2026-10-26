import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import {
  applyDeletionJournal,
  readDeletionJournalRecords,
  serializeDeletionJournal,
} from "../../src/krater/retention.ts";
import {
  readSponsorSuspension,
  readSponsorSuspensionStatus,
  sponsorMutationRefusal,
  suspendSponsor,
} from "../../src/moderation/sponsor-suspension.ts";
import { sponsorSuspensionHttp } from "../../src/moderation/sponsor-suspension-http.ts";
import { decideScreeningCase } from "../../src/moderation/store.ts";

const SPONSOR = "usr_suspension_test";
const OTHER = "usr_suspension_other";
const OPERATOR = "usr_operator_test";
const CASE = `QC-${"1".repeat(26)}`;
type Value = string | number | null;

// A SQL unit fixture, not an integration claim: all shipped migrations and
// legal enrollment commands execute on Bun SQLite. Workerd proof is separate.
async function fixture() {
  const sql = new Database(":memory:", { strict: true });
  const directory = new URL("../../../../db/migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(new URL(file, directory), "utf8"));
  function prepare(query: string) {
    let args: Value[] = [];
    const statement = {
      bind(...values: Value[]) {
        args = values;
        return statement;
      },
      async first() {
        return sql.query(query).get(...args);
      },
      async all() {
        return statement.execute();
      },
      async run() {
        return statement.execute();
      },
      execute() {
        const results = sql.query(query).all(...args);
        return {
          success: true,
          results,
          meta: { changes: (sql.query("SELECT changes() AS n").get() as { n: number }).n },
        };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return sql.transaction(() => statements.map((s) => s.execute()))();
    },
  } as unknown as D1Database;
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  });
  const principal = { type: "sponsor" as const, sponsorId: SPONSOR };
  await service.bootstrapSponsor(principal);
  await service.bootstrapSponsor({ type: "sponsor", sponsorId: OTHER });
  const grant = await service.mint(principal, { requested_scopes: ["review", "promote"] });
  const claim = await service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "suspension-fellow",
    model: "test/model",
    harness: "curl",
  });
  await service.decide(principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const tokenReply = await service.poll({ flow_handle: claim.flowHandle });
  if (!("token" in tokenReply)) throw new Error("fixture token was not issued");
  const token = tokenReply.token;
  const binding = await service.credentialBinding(token);
  if (binding === undefined) throw new Error("fixture credential was not live");
  const transfer = await service.initiateSponsorFellowTransfer(principal, {
    fellow_id: binding.fellowId,
    target_sponsor_id: OTHER,
    confirm: "initiate-fellow-transfer",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const pending = await service.mint(principal, { requested_scopes: ["review"] });
  await service.claim({
    enrollment_id: pending.enrollmentId,
    secret: pending.secret,
    name: "pending-suspension",
    model: "test/model",
    harness: "curl",
  });
  const iso = new Date().toISOString();
  sql
    .query("INSERT INTO problems(id, created_at, updated_at) VALUES ('P-SUSPEND', ?, ?)")
    .run(iso, iso);
  sql
    .query(`INSERT INTO screening_cases
    (case_id, problem_id, fellow_id, sponsor_id, route, input_digest, context_digest,
     candidate_json, coarse_category, outcome, decision_path, provider_status,
     model_version, policy_version, configuration_digest, state, created_at)
    VALUES (?, 'P-SUSPEND', ?, ?, 'promote', ?, ?, ?, 'injection', 'quarantine', 'model', 'ok',
      'fixture-model', 'fixture-policy', ?, 'pending', ?)`)
    .run(
      CASE,
      binding.fellowId,
      SPONSOR,
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify({ statement: "Private held fixture candidate" }),
      "c".repeat(64),
      iso,
    );
  await decideScreeningCase(db, OPERATOR, {
    caseId: CASE,
    decision: "confirm_rejection",
    reason: "The operator reviewed the held fixture candidate.",
  });
  const command = {
    sponsor_id: SPONSOR,
    expected_revision: 0 as const,
    reviewed_case_id: CASE,
    basis: "egregious-reviewed-case" as const,
    reason: "Explicit trained review of an egregious case.",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  };
  return { sql, db, service, token, binding, command, transfer, pending, principal };
}

describe("reviewed sponsor suspension", () => {
  test("one durable decision pauses Fellows, revokes tokens and cancels pending authority", async () => {
    const f = await fixture();
    try {
      expect((await readSponsorSuspension(f.db, SPONSOR)).impact).toEqual({
        active_fellows: 1,
        unrevoked_credentials: 1,
        pending_enrollments: 1,
        pending_transfers: 1,
      });
      const result = await suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "reviewed-case-1");
      expect(result.affected).toEqual({
        paused_fellows: 1,
        revoked_credentials: 1,
        cancelled_enrollments: 1,
        cancelled_transfers: 1,
      });
      expect(await f.service.credentialBinding(f.token)).toBeUndefined();
      expect(f.sql.query("SELECT status FROM enrollment_fellows").get()).toEqual({
        status: "paused",
      });
      expect(f.sql.query("SELECT status FROM sponsor_fellow_transfers").get()).toEqual({
        status: "cancelled",
      });
      expect((await readSponsorSuspension(f.db, SPONSOR)).impact).toEqual({
        active_fellows: 0,
        unrevoked_credentials: 0,
        pending_enrollments: 0,
        pending_transfers: 0,
      });
      const own = await readSponsorSuspensionStatus(f.db, SPONSOR);
      expect(own.status).toBe("suspended");
      expect(JSON.stringify(own)).not.toContain(f.command.reason);
      expect(JSON.stringify(own)).not.toContain(CASE);
      const publicLog = f.sql
        .query("SELECT * FROM moderation_log WHERE action = 'sponsor-suspended'")
        .get();
      expect(publicLog).toMatchObject({
        subject: "sponsor",
        problem_id: null,
        category: "reviewed-account-action",
      });
      expect(JSON.stringify(publicLog)).not.toContain(SPONSOR);
      expect(JSON.stringify(publicLog)).not.toContain(f.command.reason);
      expect(await readSponsorSuspensionStatus(f.db, OTHER)).toMatchObject({ status: "active" });
      expect(
        (await readDeletionJournalRecords(f.db)).filter((r) => r.action === "suspend-sponsor"),
      ).toHaveLength(1);
    } finally {
      f.sql.close();
    }
  });

  test("journal failure rolls the suspension, cascade, audit and public notation back", async () => {
    const f = await fixture();
    try {
      f.sql.exec(`CREATE TRIGGER planted_journal_failure BEFORE INSERT ON deletion_journal
        WHEN NEW.action = 'suspend-sponsor' BEGIN SELECT RAISE(ABORT, 'planted journal failure'); END;`);
      await expect(suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "rollback")).rejects.toThrow(
        "planted journal failure",
      );
      expect((await readSponsorSuspension(f.db, SPONSOR)).status).toBe("active");
      expect(await f.service.credentialBinding(f.token)).toBeDefined();
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'sponsor.suspended'")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM moderation_log WHERE action = 'sponsor-suspended'")
          .get(),
      ).toEqual({ n: 0 });
      f.sql.exec("DROP TRIGGER planted_journal_failure");
      expect((await suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "rollback")).status).toBe(
        "suspended",
      );
    } finally {
      f.sql.close();
    }
  });

  test("same-key races deliver one immutable receipt; stale and changed commands cannot duplicate it", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "same-intent"),
        ),
      );
      for (const result of results) expect(result).toEqual(results[0]);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM sponsor_suspension_events").get()).toEqual({
        n: 1,
      });
      expect(
        await suspendSponsor(
          f.db,
          SPONSOR,
          OPERATOR,
          { ...f.command, step_up_authenticated_at: 0 },
          "same-intent",
        ),
      ).toEqual(results[0]);
      await expect(
        suspendSponsor(
          f.db,
          SPONSOR,
          OPERATOR,
          { ...f.command, reason: "A different decision rationale." },
          "same-intent",
        ),
      ).rejects.toThrow("REPLAY_CONFLICT");
      await expect(suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "new-key")).rejects.toThrow(
        "CONFLICT",
      );
      expect(() =>
        f.sql.exec("UPDATE sponsor_suspension_events SET reason = 'different reason here'"),
      ).toThrow("SPONSOR_SUSPENSION_IMMUTABLE");
      expect(() => f.sql.exec("DELETE FROM sponsor_suspension_events")).toThrow(
        "SPONSOR_SUSPENSION_IMMUTABLE",
      );
    } finally {
      f.sql.close();
    }
  });

  test("concrete target, reviewed case and recent-auth boundaries refuse without effects", async () => {
    const f = await fixture();
    try {
      await expect(suspendSponsor(f.db, OTHER, OPERATOR, f.command, "bad-target")).rejects.toThrow(
        "TARGET",
      );
      await expect(
        suspendSponsor(
          f.db,
          SPONSOR,
          OPERATOR,
          { ...f.command, reviewed_case_id: `QC-${"2".repeat(26)}` },
          "bad-case",
        ),
      ).rejects.toThrow("CASE");
      for (const stamp of [Math.floor(Date.now() / 1000) - 901, Math.floor(Date.now() / 1000) + 60])
        await expect(
          suspendSponsor(
            f.db,
            SPONSOR,
            OPERATOR,
            { ...f.command, step_up_authenticated_at: stamp },
            `age-${stamp}`,
          ),
        ).rejects.toThrow("STEP_UP");
      const response = await sponsorSuspensionHttp({
        db: f.db,
        sponsorId: SPONSOR,
        operatorId: OPERATOR,
        method: "POST",
        body: { ...f.command, expected_revision: 1 },
        idempotencyKey: "schema",
      });
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect((await readSponsorSuspension(f.db, SPONSOR)).status).toBe("active");
    } finally {
      f.sql.close();
    }
  });

  test("suspension denies new authority in HTTP policy and D1 while retaining diagnostic reads", async () => {
    const f = await fixture();
    try {
      await suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "guard");
      expect((await sponsorMutationRefusal(f.db, SPONSOR, "POST", "enrollment.mint"))?.status).toBe(
        403,
      );
      for (const [method, action] of [
        ["GET", "fellows.list"],
        ["POST", "sponsor.account.export-page"],
        ["POST", "sponsor.account.delete"],
        ["POST", "sponsor.bootstrap"],
        ["POST", "workshop.read"],
        ["POST", "workshop.list"],
      ])
        expect(
          await sponsorMutationRefusal(f.db, SPONSOR, method as string, action as string),
        ).toBeUndefined();
      expect(await sponsorMutationRefusal(f.db, OTHER, "POST", "enrollment.mint")).toBeUndefined();
      await expect(f.service.mint(f.principal, { requested_scopes: ["review"] })).rejects.toThrow();
      for (const table of [
        "enrollment_records",
        "enrollment_grants",
        "enrollment_fellows",
        "fellow_tokens",
        "sponsor_fellow_transfers",
      ])
        expect(() => f.sql.exec(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`)).toThrow(
          "SPONSOR_SUSPENDED",
        );
      expect(() =>
        f.sql
          .query("UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?")
          .run(f.binding.fellowId),
      ).toThrow("SPONSOR_SUSPENDED");
      expect(() =>
        f.sql
          .query(`INSERT INTO screening_posture_clearances
        (clearance_id, fellow_id, cleared_by, cleared_by_class, reason, created_at)
        VALUES ('PC-inflight', ?, ?, 'sponsor', 'In-flight clearance after the suspension.', ?)`)
          .run(f.binding.fellowId, SPONSOR, new Date().toISOString()),
      ).toThrow("SPONSOR_SUSPENDED");
      expect(() =>
        f.sql
          .query(`INSERT INTO sessions(session_id, fellow_id, problem_id, opened_at, last_heartbeat_at, idle_close_at)
        VALUES ('blocked-session', ?, 'P-SUSPEND', ?, ?, ?)`)
          .run(
            f.binding.fellowId,
            new Date().toISOString(),
            new Date().toISOString(),
            new Date(Date.now() + 3600000).toISOString(),
          ),
      ).toThrow("SPONSOR_SUSPENDED");
    } finally {
      f.sql.close();
    }
  });

  test("suspension leaves the existing account deletion path usable without losing its audit", async () => {
    const f = await fixture();
    try {
      const suspension = await suspendSponsor(
        f.db,
        SPONSOR,
        OPERATOR,
        f.command,
        "erase-after-suspension",
      );
      const deleted = await f.service.deleteSponsorAccount(f.principal, {
        confirm: "delete-sponsor-account-and-revoke-all-fellows",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      });
      expect(deleted.acknowledged).toBe(true);
      expect(
        f.sql.query("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?").get(SPONSOR),
      ).toMatchObject({ tombstoned_at: expect.any(Number) });
      expect(
        f.sql.query("SELECT status, suspension_event_id FROM enrollment_fellows").get(),
      ).toEqual({ status: "revoked", suspension_event_id: suspension.event_id });
      expect(f.sql.query("SELECT event_id FROM sponsor_suspension_events").get()).toEqual({
        event_id: suspension.event_id,
      });
      expect(
        await suspendSponsor(
          f.db,
          SPONSOR,
          OPERATOR,
          { ...f.command, step_up_authenticated_at: 0 },
          "erase-after-suspension",
        ),
      ).toEqual(suspension);
      expect(await f.service.credentialBinding(f.token)).toBeUndefined();
    } finally {
      f.sql.close();
    }
  });

  test("a signed journal refuses a pre-suspension snapshot instead of reviving authority", async () => {
    const f = await fixture();
    const old = await fixture();
    try {
      await suspendSponsor(f.db, SPONSOR, OPERATOR, f.command, "restore");
      const controls = (await readDeletionJournalRecords(f.db)).filter(
        (r) => r.action === "suspend-sponsor",
      );
      const signing = await checkpointSigningKey(
        JSON.stringify({ kid: "suspension-journal", seedHex: "12".repeat(32) }),
      );
      if (!signing) throw new Error("fixture signing unavailable");
      const journal = await serializeDeletionJournal(controls, new Date().toISOString(), signing);
      const options = {
        targetIdentifier: "scratch_suspension_restore",
        deletionJournalNdjson: journal,
        verifyKeys: [{ kid: signing.kid, publicKeyHex: signing.publicKeyHex }],
      };
      await expect(applyDeletionJournal({ ...options, db: old.db })).rejects.toThrow(
        "SPONSOR_SUSPENSION_RESTORE_REQUIRED",
      );
      expect((await applyDeletionJournal({ ...options, db: f.db })).appliedControlsCount).toBe(1);
    } finally {
      f.sql.close();
      old.sql.close();
    }
  });
});
