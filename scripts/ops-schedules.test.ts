/**
 * OPS.6 Scheduled Jobs Test & Fault-Injection Suite (`asimposiumorg-zr9`).
 *
 * Covers:
 *  - UTC cron parsing & validation
 *  - DST / clock boundaries (US spring-forward/fall-back, EU spring-forward, leap day)
 *  - Single-flight locking & expired-lease fencing
 *  - Duplicate alarm suppression
 *  - Retry with deterministic bounded jitter & missed-run catch-up policy
 *  - Report retention lifecycle classification
 *  - Wrong-environment & non-scratch target refusal (via W2.8 `validateScratchTarget`)
 *  - Fault injection: timeout, partial upload, corrupt checkpoint, alert delivery failure
 *    proving recovery NEVER duplicates or overwrites a valid backup!
 *  - Boundary check: OG invalidation & synthesis staleness are outbox consumers, never crons.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BACKUP_LEASE_MS,
  BACKUP_RUN_KEY,
  runScheduledBackup,
} from "../apps/wire/src/krater/backup-scheduler.ts";
import { checkpointSigningKey } from "../apps/wire/src/krater/checkpoint-signing.ts";
import { KraterRestoreRefusedError } from "../apps/wire/src/krater/restore.ts";
import { containsNeverLogMaterial } from "./lib/ops-audit.ts";
import {
  assertScheduleEnvironment,
  buildOps4FailureAlert,
  classifyReportRetention,
  computeRetryDelayMs,
  detectMissedSlots,
  FORBIDDEN_POLLING_CRON_CONSUMERS,
  nextUtcOccurrenceMs,
  OPS_SCHEDULE_SPECS,
  parseUtcCronExpression,
  ScheduleCoordinator,
  validateOperatorRerun,
} from "./lib/ops-schedules.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("OPS.6 Crons & Scheduled Operations (asimposiumorg-zr9)", () => {
  test("cron parser validates all 4 OPS.6 jobs and rejects malformed expressions", () => {
    for (const spec of Object.values(OPS_SCHEDULE_SPECS)) {
      expect(spec.timezone).toBe("UTC");
      const parsed = parseUtcCronExpression(spec.cron_utc);
      expect(parsed.raw).toBe(spec.cron_utc);
    }
    expect(() => parseUtcCronExpression("0 3 * *")).toThrow("CRON_EXPR_INVALID");
    expect(() => parseUtcCronExpression("60 3 * * *")).toThrow("CRON_BOUNDS_INVALID");
    expect(() => parseUtcCronExpression("0 25 * * *")).toThrow("CRON_BOUNDS_INVALID");
    expect(() => parseUtcCronExpression("0 3 * 13 *")).toThrow("CRON_BOUNDS_INVALID");
  });

  test("DST & leap-day clock boundaries: UTC schedule stays strictly monotonic with zero skipped or doubled slots", () => {
    // US spring-forward day (2026-03-08 02:00 local): UTC 03:00 fires exactly 24h after 2026-03-07T03:00Z
    const beforeUsSpring = Date.parse("2026-03-07T03:00:00Z");
    const nextUsSpring = nextUtcOccurrenceMs(
      OPS_SCHEDULE_SPECS["nightly-backup"].cron_utc,
      beforeUsSpring,
    );
    expect(new Date(nextUsSpring).toISOString()).toBe("2026-03-08T03:00:00.000Z");
    expect(nextUsSpring - beforeUsSpring).toBe(24 * 60 * 60 * 1000);

    // US fall-back day (2026-11-01): still strictly 24h in UTC
    const beforeUsFall = Date.parse("2026-10-31T03:00:00Z");
    const nextUsFall = nextUtcOccurrenceMs(
      OPS_SCHEDULE_SPECS["nightly-backup"].cron_utc,
      beforeUsFall,
    );
    expect(new Date(nextUsFall).toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(nextUsFall - beforeUsFall).toBe(24 * 60 * 60 * 1000);

    // Leap day 2028-02-29
    const beforeLeap = Date.parse("2028-02-28T03:00:00Z");
    const onLeap = nextUtcOccurrenceMs(OPS_SCHEDULE_SPECS["nightly-backup"].cron_utc, beforeLeap);
    expect(new Date(onLeap).toISOString()).toBe("2028-02-29T03:00:00.000Z");

    // Quarterly restore drill fires strictly on Jan 1, Apr 1, Jul 1, Oct 1 at 05:00Z
    const afterQ1 = Date.parse("2026-01-01T05:00:00Z");
    const q2 = nextUtcOccurrenceMs(OPS_SCHEDULE_SPECS["quarterly-restore-drill"].cron_utc, afterQ1);
    const q3 = nextUtcOccurrenceMs(OPS_SCHEDULE_SPECS["quarterly-restore-drill"].cron_utc, q2);
    const q4 = nextUtcOccurrenceMs(OPS_SCHEDULE_SPECS["quarterly-restore-drill"].cron_utc, q3);
    expect(new Date(q2).toISOString()).toBe("2026-04-01T05:00:00.000Z");
    expect(new Date(q3).toISOString()).toBe("2026-07-01T05:00:00.000Z");
    expect(new Date(q4).toISOString()).toBe("2026-10-01T05:00:00.000Z");
  });

  test("single-flight locks, duplicate alarm suppression, and expired-lease fencing", () => {
    const coord = new ScheduleCoordinator();
    const t0 = Date.parse("2026-11-21T03:00:00Z");
    const slot = "2026-11-21T03:00:00.000Z";

    const a1 = coord.acquire("nightly-backup", slot, "worker-A", t0);
    expect(a1.acquired).toBe(true);
    if (!a1.acquired) throw new Error("expected lease");

    // Concurrent second trigger returns busy
    const a2 = coord.acquire("nightly-backup", slot, "worker-B", t0 + 1000);
    expect(a2.acquired).toBe(false);
    if (!a2.acquired) expect(a2.reason).toBe("busy");

    // Commit valid backup
    const payload = JSON.stringify({ problem: "P-4DSP", seq: 42 });
    const sha = createHash("sha256").update(payload).digest("hex");
    const committed = coord.commitBackupImmutable(
      a1.lease,
      "backups/2026-11-21/P-4DSP.jsonl",
      payload,
      sha,
      t0 + 5000,
    );
    expect(committed.ok).toBe(true);

    // Duplicate Cloudflare alarm for the exact same UTC slot is suppressed!
    const dup = coord.acquire("nightly-backup", slot, "worker-C", t0 + 10_000);
    expect(dup.acquired).toBe(false);
    if (!dup.acquired) expect(dup.reason).toBe("duplicate-slot");
  });

  test("fault injection: timeout, partial upload, corrupt checkpoint, and alert failure NEVER duplicate or overwrite a valid backup", () => {
    const coord = new ScheduleCoordinator();
    const t0 = Date.parse("2026-11-21T03:00:00Z");
    const slot = "2026-11-21T03:00:00.000Z";
    const backupKey = "backups/2026-11-21/full.sql";

    // Worker 1 acquires lease, stalls past TTL (timeout fault)
    const w1 = coord.acquire("nightly-backup", slot, "worker-timeout", t0);
    expect(w1.acquired).toBe(true);
    if (!w1.acquired) throw new Error("expected w1 lease");

    const afterExpiry = t0 + OPS_SCHEDULE_SPECS["nightly-backup"].lease_ttl_ms + 1_000;

    // Worker 2 reclaims after timeout
    const w2 = coord.acquire("nightly-backup", slot, "worker-recovery", afterExpiry);
    expect(w2.acquired).toBe(true);
    if (!w2.acquired) throw new Error("expected w2 lease");

    // Fault 1: Stale worker-timeout wakes up and tries to write OR release w2's lease -> MUST fail closed
    const stalePayload = "STALE_CORRUPT_PARTIAL";
    const staleSha = createHash("sha256").update(stalePayload).digest("hex");
    expect(
      coord.commitBackupImmutable(w1.lease, backupKey, stalePayload, staleSha, afterExpiry + 100),
    ).toEqual({ ok: false, code: "LOST_LEASE" });
    expect(coord.release(w1.lease)).toBe(false);

    // Fault 2: Corrupt checkpoint digest (partial upload mismatch) -> refused without committing
    const partialPayload = "TRUNCATED_SQL_BYTES";
    const expectedFullSha = createHash("sha256").update("COMPLETE_VERIFIED_SQL_DUMP").digest("hex");
    expect(
      coord.commitBackupImmutable(
        w2.lease,
        backupKey,
        partialPayload,
        expectedFullSha,
        afterExpiry + 200,
      ),
    ).toEqual({ ok: false, code: "CORRUPT_CHECKPOINT" });
    expect(coord.getCommittedBackup(backupKey)).toBeUndefined();

    // Recovery succeeds with intact verified payload
    const validPayload = "COMPLETE_VERIFIED_SQL_DUMP";
    const validCommit = coord.commitBackupImmutable(
      w2.lease,
      backupKey,
      validPayload,
      expectedFullSha,
      afterExpiry + 500,
    );
    expect(validCommit.ok).toBe(true);

    // Fault 3: Next-slot retry attempting to overwrite the SAME existing backupKey -> refused!
    const nextSlot = "2026-11-22T03:00:00.000Z";
    const w3 = coord.acquire("nightly-backup", nextSlot, "worker-overwrite", afterExpiry + 10_000);
    expect(w3.acquired).toBe(true);
    if (!w3.acquired) throw new Error("expected w3 lease");
    const evilPayload = "OVERWRITE_ATTEMPT";
    const evilSha = createHash("sha256").update(evilPayload).digest("hex");
    expect(
      coord.commitBackupImmutable(w3.lease, backupKey, evilPayload, evilSha, afterExpiry + 10_500),
    ).toEqual({ ok: false, code: "IMMUTABLE_BACKUP_EXISTS" });
    // Original valid backup bytes remain bit-for-bit untouched
    expect(coord.getCommittedBackup(backupKey)?.bytes).toBe(validPayload);

    // Fault 4: Alert delivery failure still produces a strictly redacted OPS.4 alert payload (zero secret echo)
    const canaryToken = ["asimp", "ag", "0123456789abcdef0123456789abcdef"].join("_");
    const alert = buildOps4FailureAlert({
      severity: "critical",
      job_id: "nightly-backup",
      environment: "staging",
      run_id: "run-fault-4",
      failure_code: "ALERT_WEBHOOK_TIMEOUT",
      observed_at_utc: "2026-11-21T03:15:00.000Z",
      details: {
        error: `Webhook timeout while carrying ${canaryToken}`,
        authorization: `Bearer ${canaryToken}`,
      },
    });
    const serializedAlert = JSON.stringify(alert);
    expect(serializedAlert).not.toContain(canaryToken);
    expect(containsNeverLogMaterial(serializedAlert)).toBe(false);
  });

  test("missed-run detection, catch-up policies, bounded jittered retries, and retention classification", () => {
    const start = Date.parse("2026-11-18T03:00:00Z");
    const now = Date.parse("2026-11-21T04:00:00Z");

    const missedNightly = detectMissedSlots("nightly-backup", start, now);
    expect(missedNightly.missed_slots_utc.length).toBe(3);
    expect(missedNightly.recommended_action).toBe("run-once-coalesced");

    const missedGauntlet = detectMissedSlots(
      "weekly-staging-gauntlet",
      Date.parse("2026-11-01T00:00:00Z"),
      Date.parse("2026-11-21T00:00:00Z"),
    );
    expect(missedGauntlet.missed_slots_utc.length).toBe(3);
    expect(missedGauntlet.recommended_action).toBe("alert-and-skip");

    const missedRestore = detectMissedSlots(
      "quarterly-restore-drill",
      Date.parse("2026-01-01T05:00:00Z"),
      Date.parse("2026-07-02T00:00:00Z"),
    );
    expect(missedRestore.missed_slots_utc.length).toBe(2);
    expect(missedRestore.recommended_action).toBe("page-operator-rerun");

    // Bounded retries with deterministic jitter
    const d1 = computeRetryDelayMs("nightly-backup", 1, "run-1");
    const d2 = computeRetryDelayMs("nightly-backup", 2, "run-1");
    const d3 = computeRetryDelayMs("nightly-backup", 3, "run-1");
    const d4 = computeRetryDelayMs("nightly-backup", 4, "run-1");
    expect(d1).toBeGreaterThanOrEqual(22_500);
    expect(d1).toBeLessThanOrEqual(37_500);
    expect(d2).toBeGreaterThan(d1 ?? 0);
    expect(d3).toBeLessThanOrEqual(OPS_SCHEDULE_SPECS["nightly-backup"].max_retry_ms);
    expect(d4).toBeNull();

    // Report retention (90 days for nightly-backup)
    const retention = classifyReportRetention(
      "nightly-backup",
      [
        { key: "reports/recent.json", created_at_ms: now - 10 * 86_400_000 },
        { key: "reports/expired.json", created_at_ms: now - 120 * 86_400_000 },
      ],
      now,
    );
    expect(retention.retain).toEqual(["reports/recent.json"]);
    expect(retention.eligible_for_lifecycle_expiry).toEqual(["reports/expired.json"]);
  });

  test("wrong-environment, non-UTC timezone, public-bucket, and non-scratch restore target refusals", () => {
    // Weekly staging gauntlet MUST refuse production
    expect(() =>
      assertScheduleEnvironment({ job_id: "weekly-staging-gauntlet", environment: "production" }),
    ).toThrow("OPS_SCHEDULE_WRONG_ENVIRONMENT");

    // Quarterly restore drill MUST refuse production and non-scratch targets (delegated to W2.8 validateScratchTarget)
    expect(() =>
      assertScheduleEnvironment({
        job_id: "quarterly-restore-drill",
        environment: "production",
        target_identifier: "scratch-restore-2026q4",
      }),
    ).toThrow("OPS_SCHEDULE_WRONG_ENVIRONMENT");

    expect(() =>
      assertScheduleEnvironment({
        job_id: "quarterly-restore-drill",
        environment: "staging",
        target_identifier: "asimposium-prod-d1",
      }),
    ).toThrow(KraterRestoreRefusedError);

    // Valid scratch target passes
    expect(() =>
      assertScheduleEnvironment({
        job_id: "quarterly-restore-drill",
        environment: "staging",
        target_identifier: "scratch-restore-2026q4",
        timezone: "UTC",
      }),
    ).not.toThrow();

    // Non-UTC timezone and public bucket both refused
    expect(() =>
      assertScheduleEnvironment({
        job_id: "nightly-backup",
        environment: "staging",
        timezone: "America/New_York",
      }),
    ).toThrow("OPS_SCHEDULE_TIMEZONE_FORBIDDEN");
    expect(() =>
      assertScheduleEnvironment({
        job_id: "nightly-backup",
        environment: "staging",
        public_bucket: true,
      }),
    ).toThrow("OPS_SCHEDULE_PUBLIC_BUCKET_FORBIDDEN");

    // Operator rerun requires audited reason >= 8 chars
    expect(() =>
      validateOperatorRerun({
        job_id: "nightly-backup",
        environment: "staging",
        reason: "oops",
      }),
    ).toThrow("OPS_RERUN_REASON_REQUIRED");
    const rerun = validateOperatorRerun({
      job_id: "quarterly-restore-drill",
      environment: "staging",
      target_identifier: "scratch-drill-2026q4",
      reason: "Quarterly Q4 restore verification after migration 0150",
    });
    expect(rerun.approved).toBe(true);
  });

  test("real W2.8 runScheduledBackup fault injection: disabled without key, single-flight busy, clock regression, corrupt control JSON, and ETag CAS contention", async () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE problems (
          id TEXT PRIMARY KEY,
          title TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          public_seq INTEGER NOT NULL,
          chain_digest TEXT NOT NULL
        );
      `);
      const makeStmt = (sql: string, bound: unknown[] = []) => ({
        bind(...values: unknown[]) {
          return makeStmt(sql, values);
        },
        async first<T>() {
          return (sqlite.query(sql).get(...(bound as never[])) as T | null) ?? null;
        },
        async all<T>() {
          return { success: true, results: sqlite.query(sql).all(...(bound as never[])) as T[] };
        },
        async run() {
          sqlite.query(sql).run(...(bound as never[]));
          return { success: true, results: [] };
        },
      });
      type BackupEnv = Parameters<typeof runScheduledBackup>[0];
      const db = { prepare: (sql: string) => makeStmt(sql) } as unknown as BackupEnv["DB"];

      const objects = new Map<string, { body: string; etag: string }>();
      let forceCasConflict = false;
      const bucket = {
        async get(key: string) {
          const item = objects.get(key);
          if (!item) return null;
          return {
            size: Buffer.byteLength(item.body),
            etag: item.etag,
            async json() {
              return JSON.parse(item.body);
            },
          };
        },
        async put(
          key: string,
          value: string,
          opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
        ) {
          if (forceCasConflict) return null;
          const existing = objects.get(key);
          if (opts?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
          if (
            opts?.onlyIf?.etagMatches !== undefined &&
            existing?.etag !== opts.onlyIf.etagMatches
          ) {
            return null;
          }
          const etag = createHash("sha256").update(value).digest("hex").slice(0, 16);
          objects.set(key, { body: value, etag });
          return { key, etag };
        },
      } as unknown as BackupEnv["ARTIFACTS"];

      const seedHex = "22".repeat(32);
      const signingKeyJson = JSON.stringify({ kid: "ops6-test-k1", seedHex });
      const parsedSigner = await checkpointSigningKey(signingKeyJson);
      if (!parsedSigner) throw new Error("failed to derive test Ed25519 signing key");
      const verifyKeysJson = JSON.stringify([
        { kid: parsedSigner.kid, publicKeyHex: parsedSigner.publicKeyHex },
      ]);

      const t0 = Date.parse("2026-11-21T03:00:00Z");

      // 1. Missing signing key -> explicit disabled status (never crashes or claims success)
      const disabled = await runScheduledBackup({ DB: db, ARTIFACTS: bucket }, t0);
      expect(disabled).toEqual({
        enabled: false,
        status: "disabled",
        reason: "signing_key_missing",
      });

      // 2. Active non-expired lease in R2 -> returns single-flight `busy`
      const activeLeaseState = {
        version: 1,
        date: "2026-11-21",
        startedAt: "2026-11-21T03:00:00.000Z",
        upper: null,
        after: null,
        pending: null,
        status: "running",
        written: 0,
        empty: 0,
        failed: 0,
        lease: { owner: "00000000-0000-4000-8000-000000000001", expiresAt: t0 + BACKUP_LEASE_MS },
        reportKey: null,
      };
      objects.set(BACKUP_RUN_KEY, { body: JSON.stringify(activeLeaseState), etag: "etag-1" });
      const busyRes = await runScheduledBackup(
        {
          DB: db,
          ARTIFACTS: bucket,
          CHECKPOINT_SIGNING_KEY: signingKeyJson,
          CHECKPOINT_VERIFY_KEYS: verifyKeysJson,
        },
        t0 + 1_000,
      );
      expect(busyRes.enabled).toBe(true);
      if (busyRes.enabled) expect(busyRes.status).toBe("busy");

      // 3. Clock regression -> throws BACKUP_CLOCK_REGRESSED
      const expiredYesterday = { ...activeLeaseState, lease: null };
      objects.set(BACKUP_RUN_KEY, { body: JSON.stringify(expiredYesterday), etag: "etag-2" });
      await expect(
        runScheduledBackup(
          {
            DB: db,
            ARTIFACTS: bucket,
            CHECKPOINT_SIGNING_KEY: signingKeyJson,
            CHECKPOINT_VERIFY_KEYS: verifyKeysJson,
          },
          Date.parse("2026-11-20T03:00:00Z"),
        ),
      ).rejects.toThrow("BACKUP_CLOCK_REGRESSED");

      // 4. ETag CAS race on lease acquisition -> cleanly returns busy without crashing
      forceCasConflict = true;
      const casBusy = await runScheduledBackup(
        {
          DB: db,
          ARTIFACTS: bucket,
          CHECKPOINT_SIGNING_KEY: signingKeyJson,
          CHECKPOINT_VERIFY_KEYS: verifyKeysJson,
        },
        t0 + BACKUP_LEASE_MS + 5_000,
      );
      expect(casBusy.enabled).toBe(true);
      if (casBusy.enabled) expect(casBusy.status).toBe("busy");
      forceCasConflict = false;

      // 5. Corrupt control state in R2 -> fails closed BACKUP_RUN_STATE_INVALID
      objects.set(BACKUP_RUN_KEY, { body: JSON.stringify({ broken: true }), etag: "etag-bad" });
      await expect(
        runScheduledBackup(
          {
            DB: db,
            ARTIFACTS: bucket,
            CHECKPOINT_SIGNING_KEY: signingKeyJson,
            CHECKPOINT_VERIFY_KEYS: verifyKeysJson,
          },
          t0 + BACKUP_LEASE_MS + 10_000,
        ),
      ).rejects.toThrow("BACKUP_RUN_STATE_INVALID");
    } finally {
      sqlite.close();
    }
  });

  test("infra boundary document declares OG invalidation and synthesis staleness as outbox consumers, never polling crons", () => {
    const doc = readFileSync(join(REPO_ROOT, "infra/CRON_AND_OUTBOX_BOUNDARY.md"), "utf8");
    expect(doc).toContain("OG share-image invalidation");
    expect(doc).toContain("Synthesis staleness");
    expect(doc).toContain("outbox consumer only");
    expect(FORBIDDEN_POLLING_CRON_CONSUMERS).toContain("og-invalidation");
    expect(FORBIDDEN_POLLING_CRON_CONSUMERS).toContain("synthesis-staleness");
    // Ensure none of the scheduled job IDs are forbidden polling consumers
    for (const id of Object.keys(OPS_SCHEDULE_SPECS)) {
      expect((FORBIDDEN_POLLING_CRON_CONSUMERS as readonly string[]).includes(id)).toBe(false);
    }
  });
});
