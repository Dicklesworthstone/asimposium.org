/**
 * OPS.6 Scheduled Job Orchestrator, Cron Parser, Single-Flight Lease Engine,
 * Missed-Run Detector, Retry/Catch-Up Policy, and OPS.4 Redacted Alerting
 * (`asimposiumorg-zr9`).
 *
 * Ownership discipline:
 *  - W2.8 owns backup/export/restore/inventory primitives (`apps/wire/src/krater/*`).
 *  - W10.1 owns the Cold-Agent Gauntlet harness (`e2e/gauntlet/run.sh`).
 *  - This module owns schedule definitions, UTC cron parsing, single-flight locks,
 *    duplicate alarm suppression, missed-run detection, bounded jittered retries,
 *    wrong-environment refusal, audited operator reruns, and redacted reporting.
 *  - OG invalidation & synthesis staleness are OUTBOX CONSUMERS, never polling crons.
 */

import { createHash } from "node:crypto";
import {
  BACKUP_LEASE_MS,
  BACKUP_RUN_KEY,
  SCHEDULED_BACKUP_LIMITS,
} from "../../apps/wire/src/krater/backup-scheduler.ts";
import { DATABASE_BACKUP_LEASE_KEY } from "../../apps/wire/src/krater/database-backup.ts";
import {
  KraterRestoreRefusedError,
  validateScratchTarget,
} from "../../apps/wire/src/krater/restore.ts";
import { containsNeverLogMaterial, redactOpsValue } from "./ops-audit.ts";

export type OpsScheduleJobId =
  | "nightly-backup"
  | "daily-artifact-inventory"
  | "weekly-staging-gauntlet"
  | "quarterly-restore-drill";

export type OpsEnvironment = "local" | "staging" | "production";

export type CatchUpPolicy = "coalesce-latest" | "skip-with-alert" | "require-operator-rerun";

export interface OpsScheduleSpec {
  readonly id: OpsScheduleJobId;
  readonly cron_utc: string;
  readonly timezone: "UTC";
  readonly allowed_environments: readonly OpsEnvironment[];
  readonly delegated_primitive: string;
  readonly lease_ttl_ms: number;
  readonly max_retries: number;
  readonly base_retry_ms: number;
  readonly max_retry_ms: number;
  readonly catch_up_policy: CatchUpPolicy;
  readonly report_retention_days: number;
  readonly requires_scratch_target: boolean;
}

/**
 * Outbox-only event-driven consumers explicitly forbidden from becoming polling crons.
 */
export const FORBIDDEN_POLLING_CRON_CONSUMERS = [
  "og-invalidation",
  "synthesis-staleness",
  "fts5-indexing",
  "embeddings-backfill-poll",
  "sponsor-notifications-poll",
] as const;

export const OPS_SCHEDULE_SPECS: Readonly<Record<OpsScheduleJobId, OpsScheduleSpec>> = {
  "nightly-backup": {
    id: "nightly-backup",
    cron_utc: "0 3 * * *",
    timezone: "UTC",
    allowed_environments: ["staging", "production"],
    delegated_primitive: `W2.8 runScheduledBackup (${BACKUP_RUN_KEY}) + runDatabaseBackup (${DATABASE_BACKUP_LEASE_KEY})`,
    lease_ttl_ms: BACKUP_LEASE_MS,
    max_retries: 3,
    base_retry_ms: 30_000,
    max_retry_ms: 300_000,
    catch_up_policy: "coalesce-latest",
    report_retention_days: 90,
    requires_scratch_target: false,
  },
  "daily-artifact-inventory": {
    id: "daily-artifact-inventory",
    cron_utc: "30 4 * * *",
    timezone: "UTC",
    allowed_environments: ["staging", "production"],
    delegated_primitive: "W2.8 listArtifactUploads + scripts/ops-artifact-inventory.ts",
    lease_ttl_ms: 10 * 60 * 1000,
    max_retries: 3,
    base_retry_ms: 15_000,
    max_retry_ms: 180_000,
    catch_up_policy: "coalesce-latest",
    report_retention_days: 180,
    requires_scratch_target: false,
  },
  "weekly-staging-gauntlet": {
    id: "weekly-staging-gauntlet",
    cron_utc: "0 6 * * 1",
    timezone: "UTC",
    allowed_environments: ["staging"],
    delegated_primitive: "W10.1 e2e/gauntlet/run.sh + R-22 scripts/ceremony-trend-check.ts",
    lease_ttl_ms: 45 * 60 * 1000,
    max_retries: 1,
    base_retry_ms: 60_000,
    max_retry_ms: 300_000,
    catch_up_policy: "skip-with-alert",
    report_retention_days: 180,
    requires_scratch_target: false,
  },
  "quarterly-restore-drill": {
    id: "quarterly-restore-drill",
    cron_utc: "0 5 1 1,4,7,10 *",
    timezone: "UTC",
    allowed_environments: ["staging"],
    delegated_primitive:
      "W2.8 validateScratchTarget + restoreProblemExport + restoreDatabaseBackup",
    lease_ttl_ms: 60 * 60 * 1000,
    max_retries: 2,
    base_retry_ms: 60_000,
    max_retry_ms: 600_000,
    catch_up_policy: "require-operator-rerun",
    report_retention_days: 365,
    requires_scratch_target: true,
  },
};

export interface ParsedCronExpr {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly raw: string;
}

function parseCronField(field: string, min: number, max: number, label: string): Set<number> {
  const result = new Set<number>();
  const parts = field.split(",");
  if (parts.length === 0) throw new Error(`CRON_FIELD_EMPTY:${label}`);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`CRON_FIELD_INVALID:${label}`);

    const [rangePart, stepPart] = trimmed.split("/");
    if (trimmed.split("/").length > 2) throw new Error(`CRON_STEP_INVALID:${label}`);
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`CRON_STEP_INVALID:${label}`);

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart?.includes("-")) {
        const bounds = rangePart.split("-");
        if (bounds.length !== 2) throw new Error(`CRON_RANGE_INVALID:${label}`);
        start = Number(bounds[0]);
        end = Number(bounds[1]);
      } else {
        start = Number(rangePart);
        end = stepPart !== undefined ? max : start;
      }
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < min ||
        end > max ||
        start > end
      ) {
        throw new Error(`CRON_BOUNDS_INVALID:${label}:${trimmed}`);
      }
    }
    for (let v = start; v <= end; v += step) {
      result.add(v);
    }
  }
  if (result.size === 0) throw new Error(`CRON_FIELD_EMPTY:${label}`);
  return result;
}

/**
 * Parse a standard 5-field UTC cron expression: `<min> <hour> <dom> <month> <dow>`.
 * Strictly rejects non-5-field strings and out-of-range values.
 */
export function parseUtcCronExpression(expr: string): ParsedCronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`CRON_EXPR_INVALID:expected 5 fields, got ${fields.length}`);
  }
  const [fMin, fHour, fDom, fMonth, fDow] = fields;
  return {
    minutes: parseCronField(fMin ?? "", 0, 59, "minute"),
    hours: parseCronField(fHour ?? "", 0, 23, "hour"),
    daysOfMonth: parseCronField(fDom ?? "", 1, 31, "dayOfMonth"),
    months: parseCronField(fMonth ?? "", 1, 12, "month"),
    daysOfWeek: parseCronField(fDow ?? "", 0, 6, "dayOfWeek"),
    raw: expr.trim(),
  };
}

export function matchesUtcCron(parsed: ParsedCronExpr, utcDate: Date): boolean {
  return (
    parsed.minutes.has(utcDate.getUTCMinutes()) &&
    parsed.hours.has(utcDate.getUTCHours()) &&
    parsed.daysOfMonth.has(utcDate.getUTCDate()) &&
    parsed.months.has(utcDate.getUTCMonth() + 1) &&
    parsed.daysOfWeek.has(utcDate.getUTCDay())
  );
}

/**
 * Compute the next strictly-future UTC occurrence (minute-aligned) after `afterMs`.
 * Operates strictly in UTC milliseconds so local host DST transitions never shift,
 * skip, or double-fire scheduled jobs.
 */
export function nextUtcOccurrenceMs(expr: string, afterMs: number): number {
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
    throw new Error("OPS_SCHEDULE_CLOCK_INVALID");
  }
  const parsed = parseUtcCronExpression(expr);
  // Advance to the start of the next whole UTC minute.
  let cursorMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  // Bound search to 400 days (covers quarterly + leap years).
  const maxCursorMs = cursorMs + 400 * 24 * 60 * 60 * 1000;
  while (cursorMs <= maxCursorMs) {
    const d = new Date(cursorMs);
    if (!parsed.months.has(d.getUTCMonth() + 1)) {
      // Jump to 1st of next UTC month at 00:00
      cursorMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    if (!parsed.daysOfMonth.has(d.getUTCDate()) || !parsed.daysOfWeek.has(d.getUTCDay())) {
      // Jump to next UTC day at 00:00
      cursorMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(d.getUTCHours())) {
      // Jump to next UTC hour at :00
      cursorMs = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours() + 1,
        0,
        0,
        0,
      );
      continue;
    }
    if (matchesUtcCron(parsed, d)) return cursorMs;
    cursorMs += 60_000;
  }
  throw new Error(`CRON_NO_NEXT_OCCURRENCE:${expr}`);
}

/**
 * Enumerate missed UTC scheduled slots between `lastCompletedMs` and `nowMs`.
 */
export function detectMissedSlots(
  jobId: OpsScheduleJobId,
  lastCompletedMs: number,
  nowMs: number,
): {
  readonly job_id: OpsScheduleJobId;
  readonly missed_slots_utc: readonly string[];
  readonly catch_up_policy: CatchUpPolicy;
  readonly recommended_action:
    | "run-once-coalesced"
    | "alert-and-skip"
    | "page-operator-rerun"
    | "none";
} {
  if (nowMs < lastCompletedMs) {
    throw new Error("OPS_SCHEDULE_CLOCK_REGRESSED");
  }
  const spec = OPS_SCHEDULE_SPECS[jobId];
  const missed: string[] = [];
  let cursor = lastCompletedMs;
  for (let i = 0; i < 64; i += 1) {
    const next = nextUtcOccurrenceMs(spec.cron_utc, cursor);
    if (next > nowMs) break;
    missed.push(new Date(next).toISOString());
    cursor = next;
  }
  if (missed.length === 0) {
    return {
      job_id: jobId,
      missed_slots_utc: [],
      catch_up_policy: spec.catch_up_policy,
      recommended_action: "none",
    };
  }
  const recommended =
    spec.catch_up_policy === "coalesce-latest"
      ? "run-once-coalesced"
      : spec.catch_up_policy === "skip-with-alert"
        ? "alert-and-skip"
        : "page-operator-rerun";
  return {
    job_id: jobId,
    missed_slots_utc: missed,
    catch_up_policy: spec.catch_up_policy,
    recommended_action: recommended,
  };
}

/**
 * Deterministic bounded exponential backoff with ±25% seeded jitter.
 */
export function computeRetryDelayMs(
  jobId: OpsScheduleJobId,
  attempt: number,
  seedKey: string,
): number | null {
  const spec = OPS_SCHEDULE_SPECS[jobId];
  if (attempt < 1 || attempt > spec.max_retries) return null;
  const rawDelay = Math.min(spec.max_retry_ms, spec.base_retry_ms * 2 ** (attempt - 1));
  const digest = createHash("sha256").update(`${jobId}:${attempt}:${seedKey}`).digest();
  const unit = (digest.readUInt32BE(0) / 0xffffffff) * 2 - 1; // [-1, 1]
  const jittered = Math.round(rawDelay * (1 + 0.25 * unit));
  return Math.max(1_000, Math.min(spec.max_retry_ms, jittered));
}

/**
 * Wrong-environment and forbidden-target refusal gate.
 * Delegates scratch-target validation directly to W2.8 `validateScratchTarget`.
 */
export function assertScheduleEnvironment(input: {
  readonly job_id: OpsScheduleJobId;
  readonly environment: OpsEnvironment;
  readonly target_identifier?: string;
  readonly timezone?: string;
  readonly public_bucket?: boolean;
}): void {
  if (input.timezone !== undefined && input.timezone !== "UTC") {
    throw new Error(`OPS_SCHEDULE_TIMEZONE_FORBIDDEN:${input.timezone}`);
  }
  if (input.public_bucket === true) {
    throw new Error("OPS_SCHEDULE_PUBLIC_BUCKET_FORBIDDEN");
  }
  const spec = OPS_SCHEDULE_SPECS[input.job_id];
  if (!spec.allowed_environments.includes(input.environment)) {
    throw new Error(
      `OPS_SCHEDULE_WRONG_ENVIRONMENT:${input.job_id} is forbidden in ${input.environment}`,
    );
  }
  if (spec.requires_scratch_target) {
    if (!input.target_identifier) {
      throw new KraterRestoreRefusedError(
        "Quarterly restore drill requires an explicit scratch target.",
      );
    }
    // Delegate directly to W2.8's scratch-target validator (zero forked logic).
    validateScratchTarget(input.target_identifier);
  }
}

export interface SingleFlightLease {
  readonly job_id: OpsScheduleJobId;
  readonly owner: string;
  readonly slot_utc: string;
  readonly acquired_at_ms: number;
  readonly expires_at_ms: number;
  readonly fencing_token: number;
}

export interface CompletedSlotRecord {
  readonly run_id: string;
  readonly backup_key: string;
  readonly backup_sha256: string;
  readonly completed_at_utc: string;
}

/**
 * In-memory / R2-CAS-compatible single-flight lock + duplicate alarm suppressor
 * + atomic backup immutability store (never overwrites an already-completed backup key).
 */
export class ScheduleCoordinator {
  private readonly leases = new Map<OpsScheduleJobId, SingleFlightLease>();
  private readonly completedSlots = new Map<string, CompletedSlotRecord>();
  private readonly committedObjects = new Map<string, { sha256: string; bytes: string }>();
  private nextFence = 1;

  acquire(
    jobId: OpsScheduleJobId,
    slotUtc: string,
    owner: string,
    nowMs: number,
  ):
    | { readonly acquired: true; readonly lease: SingleFlightLease }
    | {
        readonly acquired: false;
        readonly reason: "duplicate-slot" | "busy";
        readonly existing?: SingleFlightLease | CompletedSlotRecord;
      } {
    const slotKey = `${jobId}::${slotUtc}`;
    const alreadyDone = this.completedSlots.get(slotKey);
    if (alreadyDone) {
      return { acquired: false, reason: "duplicate-slot", existing: alreadyDone };
    }
    const existing = this.leases.get(jobId);
    if (existing && existing.expires_at_ms > nowMs) {
      return { acquired: false, reason: "busy", existing };
    }
    const spec = OPS_SCHEDULE_SPECS[jobId];
    const lease: SingleFlightLease = {
      job_id: jobId,
      owner,
      slot_utc: slotUtc,
      acquired_at_ms: nowMs,
      expires_at_ms: nowMs + spec.lease_ttl_ms,
      fencing_token: this.nextFence++,
    };
    this.leases.set(jobId, lease);
    return { acquired: true, lease };
  }

  /**
   * Commit a verified backup artifact immutably. Rejects stale/expired fencing tokens
   * and refuses to overwrite an already-valid backup object at the same key.
   */
  commitBackupImmutable(
    lease: SingleFlightLease,
    backupKey: string,
    payload: string,
    expectedSha256: string,
    nowMs: number,
  ):
    | { readonly ok: true; readonly record: CompletedSlotRecord }
    | {
        readonly ok: false;
        readonly code: "LOST_LEASE" | "CORRUPT_CHECKPOINT" | "IMMUTABLE_BACKUP_EXISTS";
      } {
    const current = this.leases.get(lease.job_id);
    if (
      !current ||
      current.owner !== lease.owner ||
      current.fencing_token !== lease.fencing_token ||
      current.expires_at_ms <= nowMs
    ) {
      return { ok: false, code: "LOST_LEASE" };
    }
    const actualSha256 = createHash("sha256").update(payload).digest("hex");
    if (actualSha256 !== expectedSha256) {
      return { ok: false, code: "CORRUPT_CHECKPOINT" };
    }
    if (this.committedObjects.has(backupKey)) {
      return { ok: false, code: "IMMUTABLE_BACKUP_EXISTS" };
    }
    this.committedObjects.set(backupKey, { sha256: actualSha256, bytes: payload });
    const record: CompletedSlotRecord = {
      run_id: `run-${lease.job_id}-${lease.fencing_token}`,
      backup_key: backupKey,
      backup_sha256: actualSha256,
      completed_at_utc: new Date(nowMs).toISOString(),
    };
    this.completedSlots.set(`${lease.job_id}::${lease.slot_utc}`, record);
    this.leases.delete(lease.job_id);
    return { ok: true, record };
  }

  /**
   * Release lease ONLY if caller still owns the exact fencing token (an expired
   * worker can never accidentally release a newer worker's lease).
   */
  release(lease: SingleFlightLease): boolean {
    const current = this.leases.get(lease.job_id);
    if (
      !current ||
      current.owner !== lease.owner ||
      current.fencing_token !== lease.fencing_token
    ) {
      return false;
    }
    this.leases.delete(lease.job_id);
    return true;
  }

  getCommittedBackup(backupKey: string): { sha256: string; bytes: string } | undefined {
    return this.committedObjects.get(backupKey);
  }
}

export interface Ops4FailureAlert {
  readonly schema: "asimposium.ops4-schedule-alert.v1";
  readonly severity: "warning" | "critical";
  readonly job_id: OpsScheduleJobId;
  readonly environment: OpsEnvironment;
  readonly run_id: string;
  readonly failure_code: string;
  readonly observed_at_utc: string;
  readonly details: unknown;
}

/**
 * Build a strictly never-log-redacted OPS.4 failure alert.
 */
export function buildOps4FailureAlert(input: {
  readonly severity: "warning" | "critical";
  readonly job_id: OpsScheduleJobId;
  readonly environment: OpsEnvironment;
  readonly run_id: string;
  readonly failure_code: string;
  readonly observed_at_utc: string;
  readonly details: Record<string, unknown>;
}): Ops4FailureAlert {
  const redactedDetails = redactOpsValue(input.details);
  const alert: Ops4FailureAlert = {
    schema: "asimposium.ops4-schedule-alert.v1",
    severity: input.severity,
    job_id: input.job_id,
    environment: input.environment,
    run_id: input.run_id,
    failure_code: input.failure_code,
    observed_at_utc: input.observed_at_utc,
    details: redactedDetails,
  };
  if (containsNeverLogMaterial(JSON.stringify(alert))) {
    throw new Error("OPS4_ALERT_REDACTION_VIOLATION");
  }
  return alert;
}

/**
 * Evaluate report retention lifecycle without deleting files (Rule 1 safe).
 */
export function classifyReportRetention(
  jobId: OpsScheduleJobId,
  reports: readonly { readonly key: string; readonly created_at_ms: number }[],
  nowMs: number,
): {
  readonly retain: readonly string[];
  readonly eligible_for_lifecycle_expiry: readonly string[];
  readonly retention_days: number;
} {
  const spec = OPS_SCHEDULE_SPECS[jobId];
  const cutoffMs = nowMs - spec.report_retention_days * 24 * 60 * 60 * 1000;
  const retain: string[] = [];
  const expired: string[] = [];
  for (const r of reports) {
    if (r.created_at_ms >= cutoffMs) retain.push(r.key);
    else expired.push(r.key);
  }
  return {
    retain,
    eligible_for_lifecycle_expiry: expired,
    retention_days: spec.report_retention_days,
  };
}

/**
 * Validate an operator manual rerun request (must provide non-empty audited reason
 * and pass environment/scratch guardrails).
 */
export function validateOperatorRerun(input: {
  readonly job_id: OpsScheduleJobId;
  readonly environment: OpsEnvironment;
  readonly reason: string;
  readonly target_identifier?: string;
}): {
  readonly approved: true;
  readonly job_id: OpsScheduleJobId;
  readonly delegated_primitive: string;
  readonly backup_segment_limits: typeof SCHEDULED_BACKUP_LIMITS;
  readonly audited_reason: string;
} {
  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < 8) {
    throw new Error("OPS_RERUN_REASON_REQUIRED: --reason must be at least 8 characters");
  }
  assertScheduleEnvironment({
    job_id: input.job_id,
    environment: input.environment,
    target_identifier: input.target_identifier,
    timezone: "UTC",
  });
  return {
    approved: true,
    job_id: input.job_id,
    delegated_primitive: OPS_SCHEDULE_SPECS[input.job_id].delegated_primitive,
    backup_segment_limits: SCHEDULED_BACKUP_LIMITS,
    audited_reason: String(redactOpsValue(trimmedReason)),
  };
}
