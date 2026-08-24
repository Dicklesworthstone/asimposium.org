import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  EnrollmentProblemBindingSchema,
  FellowNameSchema,
  FellowTokenSchema,
  MAX_S2_COST_RECEIPT_BYTES,
  type PromoteResponse,
  PromoteResponseSchema,
  parseS2CostMeasurementReceiptBytes,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_METRIC_SCOPE,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2_FAILED_RETRY_SCOPE,
  S2_LOCAL_SCOPE,
  S2_SUCCESSFUL_BATCH_SCOPE,
  S2_WRITE_CLAIM_SCOPE,
  type S2CostMeasurementReceipt,
  SessionOpenResponseSchema,
  WorkshopObjectIdSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { OUTBOX_IDLE_RECONCILE_MS } from "./outbox-do";

const origin = process.env.S2_ORIGIN;
const phase = process.env.S2_PHASE ?? "exercise";
const harnessToken = process.env.S2_HARNESS_TOKEN;

const REVISION = process.env.S2_GIT_HEAD;
const DIRTY_STATE = process.env.S2_GIT_DIRTY;
const SOURCE_DIGEST = process.env.S2_SOURCE_DIGEST;
const SEED = "s2-local-chain-v2";
const SCOPE = S2_LOCAL_SCOPE;
const BINDINGS: S2CostMeasurementReceipt["bindings"] = {
  d1: "DB",
  durable_object: "KRATER_OUTBOX",
  r2: null,
};
const S2_IDLE_RECONCILE_CLOCK_TOLERANCE_MS = 1_000;
const LOWER_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HARNESS_TOKEN_PATTERN = LOWER_SHA256_PATTERN;
const SUCCESSFUL_BATCH_METRIC_SCOPE: typeof S2_SUCCESSFUL_BATCH_SCOPE = S2_SUCCESSFUL_BATCH_SCOPE;
const FAILED_RETRY_BATCH_METRICS: typeof S2_FAILED_RETRY_SCOPE = S2_FAILED_RETRY_SCOPE;
const WRITE_CLAIM_WALL_SCOPE: typeof S2_WRITE_CLAIM_SCOPE = S2_WRITE_CLAIM_SCOPE;
const CREATED_AT = "2026-08-14T00:00:00.000Z";
const PRIMARY_PROBLEM = "P-s2";
const SECONDARY_PROBLEM = "P-s2-b";
const ALLOCATION_PROBLEM = "P-s2-allocation";
const ROLLBACK_PROBLEM = "P-s2-rollback";
const SEQUENCE_BOUNDARY_PROBLEM = "P-s2-sequence-boundary";
const UNSAFE_PERSISTED_SEQUENCE_PROBLEM = "P-s2-unsafe-persisted-sequence";
const LARGE_PROBLEM = "P-s2-large";
const OUTBOX_PROBLEM = "P-s2-outbox";
/**
 * The mounted-production promotion subjects (6js.5). Each drives the real
 * `createApp` session path -- POST /v1/sessions -> workshop -> promote with a
 * seeded Fellow bearer -- against this run's actual D1 and KRATER_OUTBOX DO, so
 * the post-commit nudge that app.ts now propagates is observed end to end rather
 * than from source order. They are their own problems so their per-problem D1
 * census stays exact and independent of the `/__s2/outbox/*`-driven counters.
 */
const MOUNTED_PROBLEM = "P-S2MOUNTED";
const MOUNTED_NO_NUDGE_PROBLEM = "P-S2NONUDGE";
const MOUNTED_BINDING_FAIL_PROBLEM = "P-S2BINDFAIL";
const MOUNTED_CAS_PROBLEM = "P-S2CAS";
/** Spans the crash: committed-but-undelivered before the restart, drained after. */
const MOUNTED_CRASH_PROBLEM = "P-S2CRASH";
const MOUNTED_PROBLEMS = [
  MOUNTED_PROBLEM,
  MOUNTED_NO_NUDGE_PROBLEM,
  MOUNTED_BINDING_FAIL_PROBLEM,
  MOUNTED_CAS_PROBLEM,
  MOUNTED_CRASH_PROBLEM,
] as const;
const UPGRADE_EXISTING_PROBLEM = "P-upgrade-existing";
const UPGRADE_EMPTY_PROBLEM = "P-upgrade-empty";

/**
 * The bounded integrity replay of `krater.ts` refuses a legacy problem larger than
 * MAX_INTEGRITY_BACKFILL_EVENTS (512). Nothing exercised that boundary, so the refusal was
 * asserted from code rather than observed. These two problems are planted through the
 * loopback-only legacy fixture route in exactly the shape 0004 describes — 0001 rows with
 * NULL digests plus the `required` backfill row — and drive both sides of the limit.
 */
const LEGACY_OVER_LIMIT_PROBLEM = "P-legacy-over-limit";
const LEGACY_AT_LIMIT_PROBLEM = "P-legacy-at-limit";
const LEGACY_OVER_LIMIT_EVENTS = 513;
const LEGACY_AT_LIMIT_EVENTS = 512;
/** A problem that finished its upgrade and then keeps accepting ordinary writes past 512. */
const LEGACY_WRITE_BOUNDARY_PROBLEM = "P-legacy-write-boundary";
/** A completed problem that later grows one undigested envelope. */
const LEGACY_MIXED_PROBLEM = "P-legacy-mixed-digest";

/**
 * Two upgraded problems whose only difference is how much history they carry, so the write
 * preflight's cost can be compared across a 64x difference in log length. They are their own
 * subjects rather than existing ones because every other problem here has its cursor and
 * counters pinned by other assertions, and this scenario has to write.
 */
const PREFLIGHT_SMALL_PROBLEM = "P-preflight-small";
const PREFLIGHT_LARGE_PROBLEM = "P-preflight-large";
const PREFLIGHT_SMALL_EVENTS = 8;
const PREFLIGHT_LARGE_EVENTS = 512;
/**
 * The preflight reads a problem head, a backfill row and the completeness probe. Three seeks
 * plus the probe's empty result is a handful of rows; the ceiling sits far under
 * PREFLIGHT_LARGE_EVENTS so a preflight that walked the log could not pass it, and far under
 * PREFLIGHT_SMALL_EVENTS's own history too. It bounds the measurement, it does not model it.
 */
const PREFLIGHT_ROWS_CEILING = 8;

export interface WriteResult {
  event_id: string;
  seq: number;
  idempotent: boolean;
  pre_cursor: number;
  post_cursor: number;
  payload_sha256: string;
  row_digest: string;
  build_digest: string;
  chain_digest: string;
  chain_version: 2;
  checkpoint_digest: string;
  write_phase_ms: number;
  successful_batch_rows_read: number;
  successful_batch_rows_written: number;
  successful_batch_sql_ms: number | null;
  successful_batch_metric_scope: typeof SUCCESSFUL_BATCH_METRIC_SCOPE;
  failed_retry_batch_metrics: typeof FAILED_RETRY_BATCH_METRICS;
  preflight_rows_read: number;
  preflight_rows_written: number;
  preflight_sql_ms: number | null;
  preflight_wall_ms: number;
  preflight_statements: number;
  preflight_fast_path: boolean;
  write_claim_wall_ms: number;
  write_claim_wall_scope: typeof WRITE_CLAIM_WALL_SCOPE;
  lock_wait_ms: null;
  retry_count: number;
  outbox_handoff: "armed" | "deferred" | "unavailable";
}

export { S2_COST_RECEIPT_RELATIVE_PATH } from "@asimposium/contracts";

import { S2_COST_RECEIPT_RELATIVE_PATH } from "@asimposium/contracts";

export type S2CostReceiptProvenance = Pick<
  S2CostMeasurementReceipt,
  "run_id" | "revision" | "dirty_state" | "source_digest"
>;

export interface S2CostReceiptOutput {
  readonly root: string;
  readonly receiptPath: string;
}

/** A parsed successful write result, narrowed to one new settled write rather than a replay. */
export interface S2SettledWriteResult extends Omit<WriteResult, "idempotent"> {
  readonly idempotent: false;
}

export interface S2CostReceiptArtifact {
  readonly relativePath: typeof S2_COST_RECEIPT_RELATIVE_PATH;
  readonly digest: string;
  readonly bytes: number;
}

export interface S2CostReceiptWriteResult {
  readonly receipt: S2CostMeasurementReceipt;
  readonly artifact: S2CostReceiptArtifact;
}

class S2CostReceiptError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "S2CostReceiptError";
  }
}

function costReceiptFailure(code: string): never {
  throw new S2CostReceiptError(code);
}

function validCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    costReceiptFailure("S2_COST_RECEIPT_METRICS_INVALID");
  }
  return value;
}

function validMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    costReceiptFailure("S2_COST_RECEIPT_METRICS_INVALID");
  }
  return value;
}

function validNullableMilliseconds(value: unknown): number | null {
  return value === null ? null : validMilliseconds(value);
}

function requireBoundSettledWrite(write: S2SettledWriteResult): void {
  if (
    write.idempotent !== false ||
    typeof write.event_id !== "string" ||
    !LOWER_SHA256_PATTERN.test(write.payload_sha256) ||
    !LOWER_SHA256_PATTERN.test(write.row_digest) ||
    !LOWER_SHA256_PATTERN.test(write.build_digest) ||
    !LOWER_SHA256_PATTERN.test(write.chain_digest) ||
    write.chain_version !== 2 ||
    !LOWER_SHA256_PATTERN.test(write.checkpoint_digest) ||
    write.successful_batch_metric_scope !== S2_SUCCESSFUL_BATCH_SCOPE ||
    write.failed_retry_batch_metrics !== S2_FAILED_RETRY_SCOPE ||
    write.write_claim_wall_scope !== S2_WRITE_CLAIM_SCOPE ||
    write.lock_wait_ms !== null ||
    !["armed", "deferred", "unavailable"].includes(write.outbox_handoff)
  ) {
    costReceiptFailure("S2_COST_RECEIPT_METRICS_INVALID");
  }
  validCount(write.seq);
  validCount(write.pre_cursor);
  validCount(write.post_cursor);
  validNullableMilliseconds(write.successful_batch_sql_ms);
  validNullableMilliseconds(write.preflight_sql_ms);
  validCount(write.preflight_rows_read);
  validCount(write.preflight_rows_written);
  validCount(write.preflight_statements);
  validMilliseconds(write.write_phase_ms);
  validMilliseconds(write.preflight_wall_ms);
  validMilliseconds(write.write_claim_wall_ms);
  validCount(write.successful_batch_rows_read);
  validCount(write.successful_batch_rows_written);
  validCount(write.retry_count);
}

function selectedSettledWrite(write: WriteResult): S2SettledWriteResult {
  // `writes` admits only successful, non-idempotent `write()` results. Replays
  // are responses to the same settled write and must not inflate its denominator.
  if (write.idempotent) costReceiptFailure("S2_COST_RECEIPT_IDEMPOTENT_REPLAY_SELECTED");
  return write as S2SettledWriteResult;
}

/**
 * Pure producer for the exact receipt parsed by S-7. The parser is deliberately
 * reused as the final structural check, so this client cannot grow a second
 * receipt schema beside the verifier's authoritative one.
 */
export function buildS2CostMeasurementReceipt(
  selectedSettledWrites: readonly S2SettledWriteResult[],
  provenance: S2CostReceiptProvenance,
): S2CostMeasurementReceipt {
  if (selectedSettledWrites.length === 0) costReceiptFailure("S2_COST_RECEIPT_EMPTY");

  const metrics = selectedSettledWrites.map((write) => {
    requireBoundSettledWrite(write);
    return {
      successfulBatchRowsRead: validCount(write.successful_batch_rows_read),
      successfulBatchRowsWritten: validCount(write.successful_batch_rows_written),
      writePhaseMs: validMilliseconds(write.write_phase_ms),
      writeClaimWallMs: validMilliseconds(write.write_claim_wall_ms),
      retryCount: validCount(write.retry_count),
      preflight: {
        rowsRead: validCount(write.preflight_rows_read),
        rowsWritten: validCount(write.preflight_rows_written),
        statements: validCount(write.preflight_statements),
        wallMs: validMilliseconds(write.preflight_wall_ms),
      },
    };
  });
  // These are deliberately per-selected-claim-write subtotals, never an S-2
  // run-wide D1 total. Integrity backfill is a separately measured migration
  // operation with its own response fields, not a successful claim WriteResult,
  // so it is outside this denominator rather than an unreported exception to it.
  // The verifier retains complete_write_row_totals and route_to_receipt_mapping
  // as unknowns; REQUIRED_ROW_TOTAL_EXCLUSIONS only describes missing metadata
  // within the selected ordinary-write measurement itself.
  const candidate: S2CostMeasurementReceipt = {
    schema_version: S2_COST_RECEIPT_SCHEMA_VERSION,
    record: S2_COST_RECEIPT_RECORD,
    run_id: provenance.run_id,
    phase: "exercise",
    revision: provenance.revision,
    dirty_state: provenance.dirty_state,
    source_digest: provenance.source_digest,
    scope: S2_LOCAL_SCOPE,
    bindings: BINDINGS,
    status: "pass",
    metric_scope: S2_COST_METRIC_SCOPE,
    write_receipt_count: metrics.length,
    successful_batch_metric_scope: S2_SUCCESSFUL_BATCH_SCOPE,
    failed_retry_batch_metrics: S2_FAILED_RETRY_SCOPE,
    write_claim_wall_scope: S2_WRITE_CLAIM_SCOPE,
    p95_write_phase_ms: percentile95(metrics.map((write) => write.writePhaseMs)),
    p95_preflight_wall_ms: percentile95(metrics.map((write) => write.preflight.wallMs)),
    p95_write_claim_wall_ms: percentile95(metrics.map((write) => write.writeClaimWallMs)),
    sum_successful_batch_rows_read: metrics.reduce(
      (total, write) => total + write.successfulBatchRowsRead,
      0,
    ),
    sum_successful_batch_rows_written: metrics.reduce(
      (total, write) => total + write.successfulBatchRowsWritten,
      0,
    ),
    sum_preflight_rows_read: metrics.reduce((total, write) => total + write.preflight.rowsRead, 0),
    sum_preflight_rows_written: metrics.reduce(
      (total, write) => total + write.preflight.rowsWritten,
      0,
    ),
    sum_preflight_statements: metrics.reduce(
      (total, write) => total + write.preflight.statements,
      0,
    ),
    sum_retry_count: metrics.reduce((total, write) => total + write.retryCount, 0),
    known_row_total_exclusions: [
      REQUIRED_ROW_TOTAL_EXCLUSIONS[0],
      REQUIRED_ROW_TOTAL_EXCLUSIONS[1],
    ],
  };

  try {
    return parseS2CostMeasurementReceiptBytes(new TextEncoder().encode(JSON.stringify(candidate)));
  } catch {
    return costReceiptFailure("S2_COST_RECEIPT_INVALID");
  }
}

function validatedReceiptPath(output: S2CostReceiptOutput): string {
  if (output.root === "" || output.receiptPath === "") {
    return costReceiptFailure("S2_COST_RECEIPT_PATH_INVALID");
  }
  const root = resolve(output.root);
  const receiptPath = resolve(output.receiptPath);
  if (receiptPath !== resolve(root, S2_COST_RECEIPT_RELATIVE_PATH)) {
    return costReceiptFailure("S2_COST_RECEIPT_PATH_INVALID");
  }
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return costReceiptFailure("S2_COST_RECEIPT_ROOT_INVALID");
    }
  } catch {
    return costReceiptFailure("S2_COST_RECEIPT_ROOT_INVALID");
  }
  try {
    const existing = lstatSync(receiptPath);
    return costReceiptFailure(
      existing.isSymbolicLink() ? "S2_COST_RECEIPT_SYMLINK_REFUSED" : "S2_COST_RECEIPT_EXISTS",
    );
  } catch (error) {
    if (error instanceof S2CostReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return costReceiptFailure("S2_COST_RECEIPT_PATH_INVALID");
    }
  }
  return receiptPath;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      costReceiptFailure("S2_COST_RECEIPT_WRITE_FAILED");
    }
    offset += written;
  }
}

function receiptDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write a receipt only to the fixed direct child of an owned S-2 run root. The final path is
 * created by hard-linking a fully written, fsynced mode-0600 staging inode: O_EXCL link
 * publication cannot replace an existing path, and no partial receipt can appear at the final
 * name. Staging files are retained evidence if publication fails; this harness never deletes.
 */
export function writeS2CostMeasurementReceipt(
  selectedSettledWrites: readonly S2SettledWriteResult[],
  provenance: S2CostReceiptProvenance,
  output: S2CostReceiptOutput,
): S2CostReceiptWriteResult {
  const receipt = buildS2CostMeasurementReceipt(selectedSettledWrites, provenance);
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  if (bytes.byteLength > MAX_S2_COST_RECEIPT_BYTES) {
    return costReceiptFailure("S2_COST_RECEIPT_TOO_LARGE");
  }
  const receiptPath = validatedReceiptPath(output);
  const stagingPath = resolve(
    output.root,
    `.${S2_COST_RECEIPT_RELATIVE_PATH}.${randomUUID()}.pending`,
  );
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = openSync(
      stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      costReceiptFailure("S2_COST_RECEIPT_MODE_INVALID");
    }
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof S2CostReceiptError) throw failure;
    if ((failure as NodeJS.ErrnoException).code === "EEXIST") {
      return costReceiptFailure("S2_COST_RECEIPT_EXISTS");
    }
    return costReceiptFailure("S2_COST_RECEIPT_WRITE_FAILED");
  }
  try {
    linkSync(stagingPath, receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return costReceiptFailure("S2_COST_RECEIPT_EXISTS");
    }
    return costReceiptFailure("S2_COST_RECEIPT_WRITE_FAILED");
  }
  let rootDescriptor: number | undefined;
  try {
    rootDescriptor = openSync(resolve(output.root), constants.O_RDONLY);
    fsyncSync(rootDescriptor);
  } catch {
    // The final name may now exist, but without a durable directory entry this
    // producer must not mint a successful exercise record or manifest claim.
    return costReceiptFailure("S2_COST_RECEIPT_WRITE_FAILED");
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
  return {
    receipt,
    artifact: {
      relativePath: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: receiptDigest(bytes),
      bytes: bytes.byteLength,
    },
  };
}

export interface S2StateResult {
  cursor: number;
  counts: Record<string, number>;
  chain_digest: string;
  chain_version: 2;
  checkpoint_digest: string | null;
  checkpoint_mode: "unsigned-v0";
}

export interface S2EventPageResult {
  readonly events: readonly S2EventDigestResult[];
  readonly sequences: readonly number[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface S2EventDigestResult {
  readonly seq: number;
  readonly row_digest: string;
  readonly chain_digest: string;
  readonly chain_version: 2;
}

export interface S2ReplayResult {
  readonly matches: boolean;
  readonly cursor: number;
  readonly event_count: number;
  readonly chain_digest: string;
  readonly chain_version: 2;
  readonly checkpoint_digest: string;
}

function parseS2Counts(body: Record<string, unknown>): Record<string, number> {
  const counts = asRecord(body.counts);
  const typedCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      fail("S2_RESPONSE_INVALID");
    }
    typedCounts[key] = value;
  }
  for (const table of [
    "events",
    "event_chain_v2",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ]) {
    safeNonnegativeIntegerAt(counts, table);
  }
  return typedCounts;
}

interface RequestResult {
  status: number;
  body: Record<string, unknown>;
  elapsedMs: number;
  contentType: string;
  requestId: string;
}

export type S2OldestPendingAgeStatus =
  | "empty"
  | "measured"
  | "degraded-invalid-timestamp"
  | "degraded-future-timestamp";

export type S2OldestPendingAgeAlert =
  | "not-pending"
  | "below-threshold"
  | "at-or-above-threshold"
  | "degraded";

export interface S2OutboxStatus {
  active: number;
  pending: number;
  alarm_at: number | null;
  owner_acquisitions: number;
  max_active: number;
  recovered_ownerships: number;
  delivery_attempts: number;
  delivered: number;
  quarantined: number;
  failures: number;
  last_backoff_ms: number | null;
  last_quarantine_code: string | null;
  last_phase: string;
  oldest_pending_age_ms: number | null;
  oldest_pending_age_status: S2OldestPendingAgeStatus;
  oldest_pending_age_alert: S2OldestPendingAgeAlert;
  oldest_pending_age_alert_threshold_ms: number;
}

export type S2OutboxAgeEvidence = Pick<
  S2OutboxStatus,
  | "oldest_pending_age_ms"
  | "oldest_pending_age_status"
  | "oldest_pending_age_alert"
  | "oldest_pending_age_alert_threshold_ms"
>;

let requestCount = 0;

const emit = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

const fail = (code: string): never => {
  throw new Error(code);
};

for (const problemId of MOUNTED_PROBLEMS) {
  if (!EnrollmentProblemBindingSchema.safeParse(problemId).success) {
    fail("S2_MOUNTED_PROBLEM_BINDING_INVALID");
  }
}

function requireHarnessToken(): string {
  const token = harnessToken;
  if (typeof token === "string" && HARNESS_TOKEN_PATTERN.test(token)) return token;
  return fail("S2_HARNESS_TOKEN_INVALID");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("S2_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail("S2_RESPONSE_INVALID");
  return value as number;
}

function safeNonnegativeIntegerAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("S2_RESPONSE_INVALID");
  }
  return value as number;
}

function safePositiveIntegerAt(record: Record<string, unknown>, key: string): number {
  const value = safeNonnegativeIntegerAt(record, key);
  if (value === 0) fail("S2_RESPONSE_INVALID");
  return value;
}

function nullableNumberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return value === null || value === undefined ? null : numberAt(record, key);
}

function nullableSafeNonnegativeIntegerAt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return value === null || value === undefined ? null : safeNonnegativeIntegerAt(record, key);
}

/** New status/evidence fields must be present data, never inherited or omitted defaults. */
function ownDataAt(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) fail("S2_RESPONSE_INVALID");
  return record[key];
}

function ownStringAt(record: Record<string, unknown>, key: string): string {
  const value = ownDataAt(record, key);
  if (typeof value !== "string") fail("S2_RESPONSE_INVALID");
  return value as string;
}

function ownNullableSafeNonnegativeIntegerAt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = ownDataAt(record, key);
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("S2_RESPONSE_INVALID");
  }
  return value as number;
}

function ownSafePositiveIntegerAt(record: Record<string, unknown>, key: string): number {
  const value = ownDataAt(record, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("S2_RESPONSE_INVALID");
  }
  return value as number;
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") fail("S2_RESPONSE_INVALID");
  return value as string;
}

function lowerSha256At(record: Record<string, unknown>, key: string): string {
  const value = stringAt(record, key);
  if (!LOWER_SHA256_PATTERN.test(value)) fail("S2_RESPONSE_INVALID");
  return value;
}

function nullableStringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return value === null || value === undefined ? null : stringAt(record, key);
}

function booleanAt(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail("S2_RESPONSE_INVALID");
  return value as boolean;
}

function requestId(): string {
  requestCount += 1;
  return `REQ-s2-${String(requestCount).padStart(4, "0")}`;
}

function requestEventId(body: Record<string, unknown> | undefined): string | null {
  return body !== undefined && typeof body.event_id === "string" ? body.event_id : null;
}

function requestDiagnostics(
  requestIdValue: string,
  scenario: string,
  pathname: string,
  eventId: string | null,
  response: RequestResult | null,
  assertionDiff: string | null,
): void {
  const body = response?.body;
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario,
    seed: SEED,
    scope: SCOPE,
    request_id: requestIdValue,
    event_id: eventId,
    route: pathname.split("?")[0],
    pre_cursor: body === undefined ? null : nullableSafeNonnegativeIntegerAt(body, "pre_cursor"),
    post_cursor: body === undefined ? null : nullableSafeNonnegativeIntegerAt(body, "post_cursor"),
    payload_sha256: body === undefined ? null : nullableStringAt(body, "payload_sha256"),
    row_digest: body === undefined ? null : nullableStringAt(body, "row_digest"),
    build_digest: body === undefined ? null : nullableStringAt(body, "build_digest"),
    chain_digest: body === undefined ? null : nullableStringAt(body, "chain_digest"),
    chain_version: body === undefined ? null : nullableNumberAt(body, "chain_version"),
    checkpoint_digest: body === undefined ? null : nullableStringAt(body, "checkpoint_digest"),
    write_phase_ms: body === undefined ? null : nullableNumberAt(body, "write_phase_ms"),
    successful_batch_rows_read:
      body === undefined ? null : nullableNumberAt(body, "successful_batch_rows_read"),
    successful_batch_rows_written:
      body === undefined ? null : nullableNumberAt(body, "successful_batch_rows_written"),
    successful_batch_sql_ms:
      body === undefined ? null : nullableNumberAt(body, "successful_batch_sql_ms"),
    successful_batch_metric_scope:
      body === undefined ? null : nullableStringAt(body, "successful_batch_metric_scope"),
    failed_retry_batch_metrics:
      body === undefined ? null : nullableStringAt(body, "failed_retry_batch_metrics"),
    preflight_rows_read: body === undefined ? null : nullableNumberAt(body, "preflight_rows_read"),
    preflight_rows_written:
      body === undefined ? null : nullableNumberAt(body, "preflight_rows_written"),
    preflight_sql_ms: body === undefined ? null : nullableNumberAt(body, "preflight_sql_ms"),
    preflight_wall_ms: body === undefined ? null : nullableNumberAt(body, "preflight_wall_ms"),
    preflight_statements:
      body === undefined ? null : nullableNumberAt(body, "preflight_statements"),
    preflight_fast_path:
      body === undefined || typeof body.preflight_fast_path !== "boolean"
        ? null
        : booleanAt(body, "preflight_fast_path"),
    write_claim_wall_ms: body === undefined ? null : nullableNumberAt(body, "write_claim_wall_ms"),
    write_claim_wall_scope:
      body === undefined ? null : nullableStringAt(body, "write_claim_wall_scope"),
    backfill_rows_read: body === undefined ? null : nullableNumberAt(body, "backfill_rows_read"),
    backfill_rows_written:
      body === undefined ? null : nullableNumberAt(body, "backfill_rows_written"),
    backfill_sql_ms: body === undefined ? null : nullableNumberAt(body, "backfill_sql_ms"),
    backfill_wall_ms: body === undefined ? null : nullableNumberAt(body, "backfill_wall_ms"),
    backfill_statements: body === undefined ? null : nullableNumberAt(body, "backfill_statements"),
    backfill_fast_path:
      body === undefined || typeof body.backfill_fast_path !== "boolean"
        ? null
        : booleanAt(body, "backfill_fast_path"),
    lock_wait_ms: body === undefined ? null : nullableNumberAt(body, "lock_wait_ms"),
    retry_count: body === undefined ? null : nullableNumberAt(body, "retry_count"),
    checkpoint_mode: body === undefined ? null : nullableStringAt(body, "checkpoint_mode"),
    assertion_diff: assertionDiff,
    status: response?.status ?? "transport-aborted",
    duration_ms: response?.elapsedMs ?? null,
  });
}

async function request(
  method: string,
  pathname: string,
  scenario: string,
  body?: Record<string, unknown>,
  timeoutMs = 5_000,
  extraHeaders: Record<string, string> = {},
): Promise<RequestResult> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const currentRequestId = requestId();
  const eventId = requestEventId(body);
  const started = performance.now();
  try {
    const token = requireHarnessToken();
    // `extraHeaders` carries the mounted-production credentials (a Fellow bearer
    // in `authorization`, the `idempotency-key`, and the injected
    // `x-s2-nudge-binding-fail` seam). It is spread first so the harness token
    // and content-type below stay authoritative, and it is deliberately kept out
    // of `requestDiagnostics`, which only ever reads typed body fields -- never a
    // header -- so the bearer never reaches a retained receipt.
    const fetchResponse = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        ...extraHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-s2-harness-token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Math.round((performance.now() - started) * 1_000) / 1_000;
    const result: RequestResult = {
      status: fetchResponse.status,
      body: asRecord(await fetchResponse.json()),
      elapsedMs,
      contentType: fetchResponse.headers.get("content-type") ?? "",
      requestId: currentRequestId,
    };
    requestDiagnostics(currentRequestId, scenario, pathname, eventId, result, null);
    return result;
  } catch (_error) {
    requestDiagnostics(currentRequestId, scenario, pathname, eventId, null, "transport-aborted");
    throw new Error("S2_TRANSPORT_ABORTED");
  }
}

async function triggerScheduledOutboxReconcile(scenario: string): Promise<void> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const currentRequestId = requestId();
  const pathname = `/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`;
  const started = performance.now();
  try {
    const fetchResponse = await fetch(`${origin}${pathname}`, {
      method: "GET",
      headers: { "x-s2-harness-token": requireHarnessToken() },
      signal: AbortSignal.timeout(5_000),
    });
    const elapsedMs = Math.round((performance.now() - started) * 1_000) / 1_000;
    await fetchResponse.text();
    const result: RequestResult = {
      status: fetchResponse.status,
      body: {},
      elapsedMs,
      contentType: fetchResponse.headers.get("content-type") ?? "",
      requestId: currentRequestId,
    };
    requestDiagnostics(currentRequestId, scenario, pathname, null, result, null);
    assertEqual(result.status, 200, "S2_OUTBOX_SCHEDULED_RECONCILE_FAILED");
  } catch (error) {
    if (error instanceof Error && error.message === "S2_OUTBOX_SCHEDULED_RECONCILE_FAILED") {
      throw error;
    }
    requestDiagnostics(currentRequestId, scenario, pathname, null, null, "transport-aborted");
    throw new Error("S2_TRANSPORT_ABORTED");
  }
}

function writeBody(
  index: number,
  problemId = PRIMARY_PROBLEM,
  statement = `Synthetic S2 claim ${index}.`,
): Record<string, unknown> {
  const scope =
    problemId === PRIMARY_PROBLEM ? "s2" : problemId.replace(/^P-/, "").replaceAll("-", "");
  const suffix = `${scope}-${String(index).padStart(3, "0")}`;
  return {
    problem_id: problemId,
    claim_id: `C-${suffix}`,
    event_id: `E-${suffix}`,
    idempotency_key: `IK-${suffix}`,
    statement,
    created_at: CREATED_AT,
  };
}

export function parseS2WriteResult(body: Record<string, unknown>): WriteResult {
  return {
    event_id: stringAt(body, "event_id"),
    seq: safePositiveIntegerAt(body, "seq"),
    idempotent: booleanAt(body, "idempotent"),
    pre_cursor: safeNonnegativeIntegerAt(body, "pre_cursor"),
    post_cursor: safeNonnegativeIntegerAt(body, "post_cursor"),
    payload_sha256: lowerSha256At(body, "payload_sha256"),
    row_digest: lowerSha256At(body, "row_digest"),
    build_digest: lowerSha256At(body, "build_digest"),
    chain_digest: lowerSha256At(body, "chain_digest"),
    chain_version: (() => {
      if (body.chain_version !== 2) fail("S2_CHAIN_VERSION_INVALID");
      return 2;
    })(),
    checkpoint_digest: lowerSha256At(body, "checkpoint_digest"),
    write_phase_ms: numberAt(body, "write_phase_ms"),
    successful_batch_rows_read: numberAt(body, "successful_batch_rows_read"),
    successful_batch_rows_written: numberAt(body, "successful_batch_rows_written"),
    successful_batch_sql_ms:
      body.successful_batch_sql_ms === null ? null : numberAt(body, "successful_batch_sql_ms"),
    successful_batch_metric_scope: (() => {
      const scope = stringAt(body, "successful_batch_metric_scope");
      if (scope !== SUCCESSFUL_BATCH_METRIC_SCOPE) fail("S2_RESPONSE_INVALID");
      return SUCCESSFUL_BATCH_METRIC_SCOPE;
    })(),
    failed_retry_batch_metrics: (() => {
      const scope = stringAt(body, "failed_retry_batch_metrics");
      if (scope !== FAILED_RETRY_BATCH_METRICS) fail("S2_RESPONSE_INVALID");
      return FAILED_RETRY_BATCH_METRICS;
    })(),
    preflight_rows_read: numberAt(body, "preflight_rows_read"),
    preflight_rows_written: numberAt(body, "preflight_rows_written"),
    preflight_sql_ms: body.preflight_sql_ms === null ? null : numberAt(body, "preflight_sql_ms"),
    preflight_wall_ms: numberAt(body, "preflight_wall_ms"),
    preflight_statements: numberAt(body, "preflight_statements"),
    preflight_fast_path: booleanAt(body, "preflight_fast_path"),
    write_claim_wall_ms: numberAt(body, "write_claim_wall_ms"),
    write_claim_wall_scope: (() => {
      const scope = stringAt(body, "write_claim_wall_scope");
      if (scope !== WRITE_CLAIM_WALL_SCOPE) fail("S2_RESPONSE_INVALID");
      return WRITE_CLAIM_WALL_SCOPE;
    })(),
    lock_wait_ms: body.lock_wait_ms === null ? null : fail("S2_RESPONSE_INVALID"),
    retry_count: numberAt(body, "retry_count"),
    outbox_handoff: (() => {
      const handoff = stringAt(body, "outbox_handoff");
      if (handoff !== "armed" && handoff !== "deferred" && handoff !== "unavailable") {
        fail("S2_RESPONSE_INVALID");
      }
      return handoff as WriteResult["outbox_handoff"];
    })(),
  };
}

function receiptMetrics(result?: WriteResult): Record<string, number | boolean | string | null> {
  if (result === undefined) {
    return {
      write_phase_ms: null,
      successful_batch_rows_read: null,
      successful_batch_rows_written: null,
      successful_batch_sql_ms: null,
      successful_batch_metric_scope: null,
      failed_retry_batch_metrics: null,
      preflight_rows_read: null,
      preflight_rows_written: null,
      preflight_sql_ms: null,
      preflight_wall_ms: null,
      preflight_statements: null,
      preflight_fast_path: null,
      write_claim_wall_ms: null,
      write_claim_wall_scope: null,
    };
  }
  return {
    write_phase_ms: result.write_phase_ms,
    successful_batch_rows_read: result.successful_batch_rows_read,
    successful_batch_rows_written: result.successful_batch_rows_written,
    successful_batch_sql_ms: result.successful_batch_sql_ms,
    successful_batch_metric_scope: result.successful_batch_metric_scope,
    failed_retry_batch_metrics: result.failed_retry_batch_metrics,
    preflight_rows_read: result.preflight_rows_read,
    preflight_rows_written: result.preflight_rows_written,
    preflight_sql_ms: result.preflight_sql_ms,
    preflight_wall_ms: result.preflight_wall_ms,
    preflight_statements: result.preflight_statements,
    preflight_fast_path: result.preflight_fast_path,
    write_claim_wall_ms: result.write_claim_wall_ms,
    write_claim_wall_scope: result.write_claim_wall_scope,
  };
}

export function parseS2StateResult(body: Record<string, unknown>): S2StateResult {
  return {
    cursor: safeNonnegativeIntegerAt(body, "cursor"),
    counts: parseS2Counts(body),
    chain_digest: lowerSha256At(body, "chain_digest"),
    chain_version: (() => {
      if (body.chain_version !== 2) fail("S2_CHAIN_VERSION_INVALID");
      return 2;
    })(),
    checkpoint_digest:
      body.checkpoint_digest === null ? null : lowerSha256At(body, "checkpoint_digest"),
    checkpoint_mode: ((): "unsigned-v0" => {
      const mode = stringAt(body, "checkpoint_mode");
      if (mode !== "unsigned-v0") fail("S2_CHECKPOINT_MODE_INVALID");
      return "unsigned-v0";
    })(),
  };
}

export function parseS2EventPageResult(body: Record<string, unknown>): S2EventPageResult {
  const rows = body.events;
  if (!Array.isArray(rows)) fail("S2_RESPONSE_INVALID");
  const events = (rows as unknown[]).map((row: unknown): S2EventDigestResult => {
    const event = asRecord(row);
    if (event.chainVersion !== 2) {
      fail("S2_CHAIN_VERSION_INVALID");
    }
    return {
      seq: safePositiveIntegerAt(event, "seq"),
      row_digest: lowerSha256At(event, "rowDigest"),
      chain_digest: lowerSha256At(event, "chainDigest"),
      chain_version: 2,
    };
  });
  return {
    events,
    sequences: events.map((event) => event.seq),
    nextCursor: safeNonnegativeIntegerAt(body, "next_cursor"),
    hasMore: booleanAt(body, "has_more"),
  };
}

export function parseS2ReplayResult(body: Record<string, unknown>): S2ReplayResult {
  return {
    matches: booleanAt(body, "matches"),
    cursor: safeNonnegativeIntegerAt(body, "cursor"),
    event_count: safeNonnegativeIntegerAt(body, "event_count"),
    chain_digest: lowerSha256At(body, "chain_digest"),
    chain_version: (() => {
      if (body.chain_version !== 2) fail("S2_CHAIN_VERSION_INVALID");
      return 2;
    })(),
    checkpoint_digest: lowerSha256At(body, "checkpoint_digest"),
  };
}

export function assertS2TerminalDigestParity(
  write: WriteResult,
  event: S2EventDigestResult,
  stateResult: S2StateResult,
  replay: S2ReplayResult,
): void {
  if (
    write.seq !== event.seq ||
    write.seq !== stateResult.cursor ||
    write.seq !== replay.cursor
  ) {
    fail("S2_TERMINAL_SEQUENCE_MISMATCH");
  }
  if (write.row_digest !== event.row_digest) fail("S2_V2_ROW_DIGEST_MISMATCH");
  if (
    write.chain_digest !== event.chain_digest ||
    write.chain_digest !== stateResult.chain_digest ||
    write.chain_digest !== replay.chain_digest
  ) {
    fail("S2_V2_CHAIN_DIGEST_MISMATCH");
  }
  if (
    write.checkpoint_digest !== stateResult.checkpoint_digest ||
    write.checkpoint_digest !== replay.checkpoint_digest
  ) {
    fail("S2_V2_CHECKPOINT_DIGEST_MISMATCH");
  }
}

function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code);
}

function hasIdleReconcileAlarm(status: S2OutboxStatus): boolean {
  return (
    status.alarm_at !== null &&
    status.alarm_at - Date.now() > OUTBOX_IDLE_RECONCILE_MS - S2_IDLE_RECONCILE_CLOCK_TOLERANCE_MS
  );
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

function canonicalState(state: S2StateResult): string {
  return JSON.stringify({
    chain_digest: state.chain_digest,
    chain_version: state.chain_version,
    checkpoint_digest: state.checkpoint_digest,
    checkpoint_mode: state.checkpoint_mode,
    counts: state.counts,
    cursor: state.cursor,
  });
}

async function seed(problemId: string, scenario: string): Promise<void> {
  const seeded = await request("POST", "/__s2/seed", scenario, {
    problem_id: problemId,
    created_at: CREATED_AT,
  });
  assertEqual(seeded.status, 201, "S2_SEED_FAILED");
}

async function state(problemId: string, scenario: string): Promise<S2StateResult> {
  const response = await request("GET", `/__s2/state?problem_id=${problemId}`, scenario);
  assertEqual(response.status, 200, "S2_STATE_READ_FAILED");
  return parseS2StateResult(response.body);
}

async function counts(problemId: string, scenario: string): Promise<Record<string, number>> {
  const response = await request("GET", `/__s2/counts?problem_id=${problemId}`, scenario);
  assertEqual(response.status, 200, "S2_COUNTS_READ_FAILED");
  return parseS2Counts(response.body);
}

async function write(
  body: Record<string, unknown>,
  scenario: string,
  timeoutMs?: number,
  deferOutboxNudge = true,
): Promise<WriteResult> {
  const requestBody = deferOutboxNudge ? { ...body, s2_defer_outbox_nudge: true } : body;
  const result = await request("POST", "/__s2/write", scenario, requestBody, timeoutMs);
  assertEqual(result.status, 200, "S2_WRITE_FAILED");
  return parseS2WriteResult(result.body);
}

async function deterministicAllocationAndRollback(): Promise<void> {
  await seed(ALLOCATION_PROBLEM, "allocation-two-writer-seed");
  const allocationFirst = writeBody(1, ALLOCATION_PROBLEM, "Deterministic allocation writer one.");
  const allocationSecond = writeBody(2, ALLOCATION_PROBLEM, "Deterministic allocation writer two.");
  // The harness invokes writer two after writer one has read its durable head and before writer
  // one enters `db.batch`. This is deterministic actual D1 writer interleaving, without holding
  // an idle D1 request open and turning the local binding's connection budget into the race.
  const allocationResponse = await request("POST", "/__s2/write", "allocation-two-writer", {
    ...allocationFirst,
    s2_defer_outbox_nudge: true,
    s2_after_head_competing_write: allocationSecond,
  });
  assertEqual(allocationResponse.status, 200, "S2_ALLOCATION_WRITER_FAILED");
  const allocationResult = parseS2WriteResult(allocationResponse.body);
  const allocatedSequences = [1, allocationResult.seq].sort((left, right) => left - right);
  assertEqual(allocatedSequences.join(","), "1,2", "S2_DATABASE_ALLOCATION_SEQUENCE_INVALID");
  assertEqual(
    allocationResult.retry_count >= 1,
    true,
    "S2_DATABASE_ALLOCATION_STALE_HEAD_RETRY_NOT_OBSERVED",
  );
  const allocationState = await state(ALLOCATION_PROBLEM, "allocation-two-writer-state");
  assertEqual(allocationState.cursor, 2, "S2_DATABASE_ALLOCATION_CURSOR_INVALID");
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "idempotency",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ]) {
    assertEqual(allocationState.counts[table], 2, "S2_DATABASE_ALLOCATION_ROW_COUNT_INVALID");
  }
  await assertReplay(ALLOCATION_PROBLEM, 2, "allocation-two-writer-replay");

  await seed(ROLLBACK_PROBLEM, "rollback-two-writer-seed");
  const firstRollbackWrite = writeBody(1, ROLLBACK_PROBLEM, "Deterministic rollback winner.");
  // This query is sent directly to FTS5 after the deliberately aborted write.
  // Keep it a single plain term: punctuation in the old sentence made the
  // rollback postcondition fail at query parsing (HTTP 400) rather than prove
  // that the late outbox abort left no searchable partial row.
  const rollbackNeedle = "lateoutboxrollbackneedle";
  const secondRollbackWrite = writeBody(2, ROLLBACK_PROBLEM, rollbackNeedle);
  const failedRollbackEventId = stringAt(secondRollbackWrite, "event_id");
  const rollbackResponse = await request("POST", "/__s2/write", "rollback-two-writer", {
    ...secondRollbackWrite,
    s2_defer_outbox_nudge: true,
    s2_after_head_competing_write: firstRollbackWrite,
    s2_force_late_outbox_rollback: true,
  });
  assertEqual(rollbackResponse.status, 409, "S2_ROLLBACK_REJECTION_STATUS_INVALID");
  assertEqual(
    rollbackResponse.body.code,
    "S2_LOCAL_LATE_OUTBOX_ROLLBACK",
    "S2_ROLLBACK_REJECTION_CODE_INVALID",
  );
  const rollbackStateResponse = await request(
    "GET",
    `/__s2/state?problem_id=${ROLLBACK_PROBLEM}&event_id=${encodeURIComponent(failedRollbackEventId)}`,
    "rollback-two-writer-state",
  );
  assertEqual(rollbackStateResponse.status, 200, "S2_ROLLBACK_STATE_READ_FAILED");
  const rollbackState = parseS2StateResult(rollbackStateResponse.body);
  assertEqual(rollbackState.cursor, 1, "S2_ROLLBACK_CURSOR_INVALID");
  // The winning write owns one row in every canonical write table. Search is
  // deliberately asynchronous: this scenario defers the outbox nudge, so the
  // winner's FTS row does not exist yet. Pinning FTS to one here confused a
  // deferred projection with a partial transaction and made the real harness
  // fail before it could inspect the planted late-outbox rollback.
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "event_content",
    "idempotency",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ]) {
    assertEqual(rollbackState.counts[table], 1, "S2_ROLLBACK_PARTIAL_BATCH_COMMIT");
  }
  assertEqual(rollbackState.counts.public_claim_fts, 0, "S2_ROLLBACK_DEFERRED_FTS_STATE_INVALID");
  assertEqual(
    safeNonnegativeIntegerAt(rollbackStateResponse.body, "event_content_for_event"),
    0,
    "S2_ROLLBACK_ORPHAN_EVENT_CONTENT",
  );
  const rollbackSearch = await request(
    "GET",
    `/__s2/search?q=${encodeURIComponent(rollbackNeedle)}`,
    "rollback-two-writer-fts-state",
  );
  assertEqual(rollbackSearch.status, 200, "S2_ROLLBACK_FTS_READ_FAILED");
  const rollbackMatches = rollbackSearch.body.matches;
  assertEqual(
    Array.isArray(rollbackMatches) ? rollbackMatches.length : -1,
    0,
    "S2_ROLLBACK_FTS_PARTIAL_BATCH_COMMIT",
  );

  // These two requests are classifier plants, not substitute rollback proof.
  // The normal late-outbox plant above still owns the full cursor/count/FTS
  // residue checks. Here, an unarmed D1 error with the right marker and an
  // armed D1 error with the wrong marker must both retain the generic face.
  // Removing either half of the worker's identity predicate turns one of these
  // expected generic failures into the local witness and fails this client.
  const classifierStateBefore = canonicalState(rollbackState);
  const unarmedIdentityWrite = writeBody(
    3,
    ROLLBACK_PROBLEM,
    "Unarmed late outbox identity classifier plant.",
  );
  const unarmedIdentity = await request(
    "POST",
    "/__s2/write",
    "rollback-unarmed-identity-classifier-negative",
    {
      ...unarmedIdentityWrite,
      s2_defer_outbox_nudge: true,
      s2_plant_unarmed_late_outbox_identity: true,
    },
  );
  assertEqual(unarmedIdentity.status, 409, "S2_UNARMED_ROLLBACK_CLASSIFIER_STATUS_INVALID");
  assertEqual(
    unarmedIdentity.body.code,
    "KRATER_WRITE_FAILED",
    "S2_UNARMED_ROLLBACK_CLASSIFIER_WITNESS_ESCAPED",
  );
  const unarmedIdentityState = await state(
    ROLLBACK_PROBLEM,
    "rollback-unarmed-identity-classifier-state",
  );
  assertEqual(
    canonicalState(unarmedIdentityState),
    classifierStateBefore,
    "S2_UNARMED_ROLLBACK_CLASSIFIER_PARTIAL_COMMIT",
  );

  const armedNonLateNeedle = "armednonlateoutboxneedle";
  const armedNonLateWrite = writeBody(4, ROLLBACK_PROBLEM, armedNonLateNeedle);
  const armedNonLate = await request(
    "POST",
    "/__s2/write",
    "rollback-armed-nonlate-classifier-negative",
    {
      ...armedNonLateWrite,
      s2_defer_outbox_nudge: true,
      s2_force_late_outbox_rollback: true,
      s2_plant_armed_nonlate_outbox_failure: true,
    },
  );
  assertEqual(armedNonLate.status, 409, "S2_ARMED_NONLATE_ROLLBACK_CLASSIFIER_STATUS_INVALID");
  assertEqual(
    armedNonLate.body.code,
    "KRATER_WRITE_FAILED",
    "S2_ARMED_NONLATE_ROLLBACK_CLASSIFIER_WITNESS_ESCAPED",
  );
  const armedNonLateState = await state(
    ROLLBACK_PROBLEM,
    "rollback-armed-nonlate-classifier-state",
  );
  assertEqual(
    canonicalState(armedNonLateState),
    classifierStateBefore,
    "S2_ARMED_NONLATE_ROLLBACK_CLASSIFIER_PARTIAL_COMMIT",
  );
  const armedNonLateSearch = await request(
    "GET",
    `/__s2/search?q=${encodeURIComponent(armedNonLateNeedle)}`,
    "rollback-armed-nonlate-fts-state",
  );
  assertEqual(armedNonLateSearch.status, 200, "S2_ARMED_NONLATE_ROLLBACK_FTS_READ_FAILED");
  assertEqual(
    Array.isArray(armedNonLateSearch.body.matches) ? armedNonLateSearch.body.matches.length : -1,
    0,
    "S2_ARMED_NONLATE_ROLLBACK_FTS_PARTIAL_BATCH_COMMIT",
  );

  // This plant makes the first local cleanup DROP fail after the normal late-outbox
  // classification. It must refuse the ordinary witness, recover the actual trigger,
  // and leave the next ordinary write free of stale trigger contamination.
  const cleanupFailureStateBefore = classifierStateBefore;
  const cleanupFailureWrite = writeBody(
    5,
    ROLLBACK_PROBLEM,
    "Late outbox cleanup failure classifier plant.",
  );
  const cleanupFailure = await request(
    "POST",
    "/__s2/write",
    "rollback-late-outbox-cleanup-failure",
    {
      ...cleanupFailureWrite,
      s2_defer_outbox_nudge: true,
      s2_force_late_outbox_rollback: true,
      s2_plant_late_outbox_cleanup_failure: true,
    },
  );
  assertEqual(cleanupFailure.status, 409, "S2_ROLLBACK_CLEANUP_FAILURE_STATUS_INVALID");
  assertEqual(
    cleanupFailure.body.code,
    "S2_LOCAL_LATE_OUTBOX_ROLLBACK_CLEANUP_FAILED",
    "S2_ROLLBACK_CLEANUP_FAILURE_FALSE_WITNESS",
  );
  const cleanupFailureState = await state(
    ROLLBACK_PROBLEM,
    "rollback-late-outbox-cleanup-failure-state",
  );
  assertEqual(
    canonicalState(cleanupFailureState),
    cleanupFailureStateBefore,
    "S2_ROLLBACK_CLEANUP_FAILURE_PARTIAL_COMMIT",
  );

  const cleanupRecoveryNeedle = "lateoutboxcleanuprecoverneedle";
  const cleanupRecovery = await request(
    "POST",
    "/__s2/write",
    "rollback-late-outbox-cleanup-recovery",
    {
      ...writeBody(6, ROLLBACK_PROBLEM, cleanupRecoveryNeedle),
      s2_defer_outbox_nudge: true,
    },
  );
  assertEqual(cleanupRecovery.status, 200, "S2_ROLLBACK_CLEANUP_STALE_TRIGGER_CONTAMINATION");
  const cleanupRecoverySearch = await request(
    "GET",
    `/__s2/search?q=${encodeURIComponent(cleanupRecoveryNeedle)}`,
    "rollback-late-outbox-cleanup-recovery-search",
  );
  assertEqual(cleanupRecoverySearch.status, 200, "S2_ROLLBACK_CLEANUP_RECOVERY_FTS_READ_FAILED");
  assertEqual(
    Array.isArray(cleanupRecoverySearch.body.matches)
      ? cleanupRecoverySearch.body.matches.length
      : -1,
    0,
    "S2_ROLLBACK_CLEANUP_RECOVERY_DEFERRED_FTS_STATE_INVALID",
  );
  await assertReplay(ROLLBACK_PROBLEM, 2, "rollback-two-writer-replay");

  for (const since of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    const safeCursor = await request(
      "GET",
      `/__s2/events?problem_id=${ROLLBACK_PROBLEM}&since=${since}&limit=1`,
      "sequence-safe-integer-positive",
    );
    assertEqual(safeCursor.status, 200, "S2_SEQUENCE_SAFE_INTEGER_READ_REJECTED");
    const page = parseS2EventPageResult(safeCursor.body);
    assertEqual(page.sequences.length, 0, "S2_SEQUENCE_SAFE_INTEGER_READ_ROWS_INVALID");
    assertEqual(page.nextCursor, since, "S2_SEQUENCE_SAFE_INTEGER_NEXT_CURSOR_INVALID");
    assertEqual(page.hasMore, false, "S2_SEQUENCE_SAFE_INTEGER_HAS_MORE_INVALID");
  }
  for (const since of ["9007199254740993", "1.5"]) {
    const unsafeCursor = await request(
      "GET",
      `/__s2/events?problem_id=${ROLLBACK_PROBLEM}&since=${since}&limit=1`,
      "sequence-safe-integer-query-negative",
    );
    assertEqual(unsafeCursor.status, 400, "S2_SEQUENCE_UNSAFE_QUERY_ACCEPTED");
    assertEqual(
      unsafeCursor.body.code,
      "KRATER_READ_INVALID",
      "S2_SEQUENCE_UNSAFE_QUERY_CODE_INVALID",
    );
  }

  const unsafePersistedSeed = await request(
    "POST",
    "/__s2/seed",
    "sequence-unsafe-persisted-seed",
    {
      problem_id: UNSAFE_PERSISTED_SEQUENCE_PROBLEM,
      created_at: CREATED_AT,
      s2_seed_unsafe_persisted_sequence: true,
    },
  );
  assertEqual(unsafePersistedSeed.status, 201, "S2_SEQUENCE_UNSAFE_PERSISTED_SEED_FAILED");
  for (const pathname of [
    `/__s2/cursor?problem_id=${UNSAFE_PERSISTED_SEQUENCE_PROBLEM}`,
    `/__s2/events?problem_id=${UNSAFE_PERSISTED_SEQUENCE_PROBLEM}&since=0&limit=1`,
  ]) {
    const unsafePersistedRead = await request(
      "GET",
      pathname,
      "sequence-unsafe-persisted-read-negative",
    );
    assertEqual(unsafePersistedRead.status, 400, "S2_SEQUENCE_UNSAFE_PERSISTED_READ_ACCEPTED");
    assertEqual(
      unsafePersistedRead.body.code,
      "KRATER_READ_INVALID",
      "S2_SEQUENCE_UNSAFE_PERSISTED_READ_CODE_INVALID",
    );
  }

  const sequenceBoundarySeed = await request("POST", "/__s2/seed", "sequence-safe-integer-seed", {
    problem_id: SEQUENCE_BOUNDARY_PROBLEM,
    created_at: CREATED_AT,
    s2_seed_public_seq: Number.MAX_SAFE_INTEGER,
  });
  assertEqual(sequenceBoundarySeed.status, 201, "S2_SEQUENCE_BOUNDARY_SEED_FAILED");
  const sequenceBoundaryWrite = await request(
    "POST",
    "/__s2/write",
    "sequence-safe-integer-negative",
    { ...writeBody(1, SEQUENCE_BOUNDARY_PROBLEM), s2_defer_outbox_nudge: true },
  );
  assertEqual(sequenceBoundaryWrite.status, 409, "S2_SEQUENCE_BOUNDARY_STATUS_INVALID");
  assertEqual(
    sequenceBoundaryWrite.body.code,
    "KRATER_SEQUENCE_EXHAUSTED",
    "S2_SEQUENCE_BOUNDARY_CODE_INVALID",
  );
  const sequenceBoundaryState = await state(
    SEQUENCE_BOUNDARY_PROBLEM,
    "sequence-safe-integer-state",
  );
  assertEqual(
    sequenceBoundaryState.cursor,
    Number.MAX_SAFE_INTEGER,
    "S2_SEQUENCE_BOUNDARY_CURSOR_MUTATED",
  );
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "event_content",
    "public_claim_fts",
    "idempotency",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ]) {
    assertEqual(sequenceBoundaryState.counts[table], 0, "S2_SEQUENCE_BOUNDARY_PARTIAL_BATCH");
  }
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: "deterministic-two-writer-database-allocation-and-rollback",
    allocation_sequences: allocatedSequences,
    stale_head_retry_observed: true,
    rollback_cursor: rollbackState.cursor,
    rollback_idempotency_rows: rollbackState.counts.idempotency,
    sequence_boundary_refused: true,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

function isOldestPendingAgeStatus(value: string): value is S2OldestPendingAgeStatus {
  return (
    value === "empty" ||
    value === "measured" ||
    value === "degraded-invalid-timestamp" ||
    value === "degraded-future-timestamp"
  );
}

function isOldestPendingAgeAlert(value: string): value is S2OldestPendingAgeAlert {
  return (
    value === "not-pending" ||
    value === "below-threshold" ||
    value === "at-or-above-threshold" ||
    value === "degraded"
  );
}

export function parseS2OutboxStatus(body: Record<string, unknown>): S2OutboxStatus {
  const rawOldestPendingAgeStatus = ownStringAt(body, "oldest_pending_age_status");
  const oldestPendingAgeStatus = isOldestPendingAgeStatus(rawOldestPendingAgeStatus)
    ? rawOldestPendingAgeStatus
    : fail("S2_RESPONSE_INVALID");
  const rawOldestPendingAgeAlert = ownStringAt(body, "oldest_pending_age_alert");
  const oldestPendingAgeAlert = isOldestPendingAgeAlert(rawOldestPendingAgeAlert)
    ? rawOldestPendingAgeAlert
    : fail("S2_RESPONSE_INVALID");
  const result: S2OutboxStatus = {
    active: numberAt(body, "active"),
    pending: numberAt(body, "pending"),
    alarm_at: nullableNumberAt(body, "alarm_at"),
    owner_acquisitions: numberAt(body, "owner_acquisitions"),
    max_active: numberAt(body, "max_active"),
    recovered_ownerships: numberAt(body, "recovered_ownerships"),
    delivery_attempts: numberAt(body, "delivery_attempts"),
    delivered: numberAt(body, "delivered"),
    quarantined: numberAt(body, "quarantined"),
    failures: numberAt(body, "failures"),
    last_backoff_ms: nullableNumberAt(body, "last_backoff_ms"),
    last_quarantine_code: nullableStringAt(body, "last_quarantine_code"),
    last_phase: stringAt(body, "last_phase"),
    oldest_pending_age_ms: ownNullableSafeNonnegativeIntegerAt(body, "oldest_pending_age_ms"),
    oldest_pending_age_status: oldestPendingAgeStatus,
    oldest_pending_age_alert: oldestPendingAgeAlert,
    oldest_pending_age_alert_threshold_ms: ownSafePositiveIntegerAt(
      body,
      "oldest_pending_age_alert_threshold_ms",
    ),
  };

  if (!Number.isSafeInteger(result.pending) || result.pending < 0) fail("S2_RESPONSE_INVALID");
  if (result.oldest_pending_age_status === "empty") {
    if (
      result.pending !== 0 ||
      result.oldest_pending_age_ms !== 0 ||
      result.oldest_pending_age_alert !== "not-pending"
    ) {
      fail("S2_RESPONSE_INVALID");
    }
  } else if (result.oldest_pending_age_status === "measured") {
    const measuredAgeMs = result.oldest_pending_age_ms;
    if (result.pending === 0 || measuredAgeMs === null) fail("S2_RESPONSE_INVALID");
    const exactMeasuredAgeMs = measuredAgeMs as number;
    const expectedAlert =
      exactMeasuredAgeMs >= result.oldest_pending_age_alert_threshold_ms
        ? "at-or-above-threshold"
        : "below-threshold";
    if (result.oldest_pending_age_alert !== expectedAlert) fail("S2_RESPONSE_INVALID");
  } else if (
    result.pending === 0 ||
    result.oldest_pending_age_ms !== null ||
    result.oldest_pending_age_alert !== "degraded"
  ) {
    fail("S2_RESPONSE_INVALID");
  }
  return result;
}

/**
 * The bound for a one-shot status read taken outside any deadline. It is the
 * value `request` would otherwise have defaulted to, named so the four
 * deadline-free callers below state their budget instead of inheriting one.
 */
const S2_OUTBOX_STATUS_TIMEOUT_MS = 5_000;

/**
 * `timeoutMs` is REQUIRED, not optional. Inside `waitForOutbox` the argument is
 * the remaining slice of the one absolute deadline; making it optional let a
 * dropped argument silently fall back to `request`'s 5s default and outlive the
 * wall it was just checked against. Required means that regression cannot
 * compile rather than merely failing a test.
 */
async function outboxStatus(scenario: string, timeoutMs: number): Promise<S2OutboxStatus> {
  const result = await request("GET", "/__s2/outbox/status", scenario, undefined, timeoutMs);
  assertEqual(result.status, 200, "S2_OUTBOX_STATUS_FAILED");
  return parseS2OutboxStatus(result.body);
}

/** The outer wall an outbox wait may occupy, start to receipt. */
export const S2_OUTBOX_DEADLINE_MS = 8_000;

/**
 * The slice of the deadline reserved for the terminal observation.
 *
 * It is carved out of `S2_OUTBOX_DEADLINE_MS` rather than added after it. An
 * observation granted its own budget would extend the same absolute deadline,
 * which is exactly the defect: the poll loop and the final observation must
 * share one wall, not two.
 */
export const S2_OUTBOX_TERMINAL_OBSERVATION_MS = 500;

/**
 * Time left before an absolute monotonic deadline, clamped at zero.
 *
 * Zero is the caller's instruction not to start: a request handed a
 * nonpositive timeout would either throw or, worse, inherit `request`'s 5s
 * default and silently outlive the deadline it was meant to respect. Exported
 * so the budget arithmetic is testable on an injected clock without giving
 * `waitForOutbox` a clock or transport seam it would not otherwise have.
 */
export function s2RemainingBudgetMs(nowMs: number, deadlineMs: number): number {
  const remaining = deadlineMs - nowMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * The terminal observation: best-effort, budget-gated, and never authoritative.
 *
 * A transport failure here must surface as an ABSENT reading, never as a thrown
 * transport error, or it would replace the typed `S2_OUTBOX_DEADLINE_EXCEEDED`
 * receipt the caller is about to emit with an unrelated failure. A nonpositive
 * budget means the poll loop already spent the wall, so no request is started
 * at all rather than one inheriting `request`'s 5s default.
 *
 * Exported for the same reason as `s2RemainingBudgetMs`: it makes the
 * containment testable on an injected observer without giving `waitForOutbox`
 * a clock or transport seam it would not otherwise have.
 */
export async function s2TerminalObservation(
  observe: () => Promise<S2OutboxStatus>,
  budgetMs: number,
): Promise<S2OutboxStatus | undefined> {
  if (budgetMs <= 0) return undefined;
  try {
    return await observe();
  } catch {
    return undefined;
  }
}

export function outboxAgeEvidence(status: S2OutboxStatus): S2OutboxAgeEvidence {
  return {
    oldest_pending_age_ms: status.oldest_pending_age_ms,
    oldest_pending_age_status: status.oldest_pending_age_status,
    oldest_pending_age_alert: status.oldest_pending_age_alert,
    oldest_pending_age_alert_threshold_ms: status.oldest_pending_age_alert_threshold_ms,
  };
}

export interface S2OutboxWaitHooks {
  readonly now: () => number;
  readonly observe: (scenario: string, timeoutMs: number) => Promise<S2OutboxStatus>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly emit: (record: Record<string, unknown>) => void;
}

const productionOutboxWaitHooks: S2OutboxWaitHooks = {
  now: () => performance.now(),
  observe: outboxStatus,
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  emit,
};

export async function s2WaitForOutbox(
  scenario: string,
  predicate: (status: S2OutboxStatus) => boolean,
  hooks: S2OutboxWaitHooks = productionOutboxWaitHooks,
): Promise<S2OutboxStatus> {
  // One absolute monotonic deadline governs every request below. Each poll is
  // handed only what remains, so a poll entered just before expiry can no
  // longer inherit a fresh 5s window and outlive the wall it was checked
  // against.
  const startedAt = hooks.now();
  const deadline = startedAt + S2_OUTBOX_DEADLINE_MS;
  const pollUntil = deadline - S2_OUTBOX_TERMINAL_OBSERVATION_MS;
  let pollReadFailed = false;
  let sawNonSatisfyingPoll = false;
  for (;;) {
    const pollBudgetMs = s2RemainingBudgetMs(hooks.now(), pollUntil);
    if (pollBudgetMs === 0) break;
    let current: S2OutboxStatus;
    try {
      current = await hooks.observe(scenario, pollBudgetMs);
    } catch {
      // A final in-flight status read may hit its bounded AbortSignal. It is
      // evidence for the deadline receipt, not a reason to bypass it.
      pollReadFailed = true;
      break;
    }
    if (predicate(current)) return current;
    sawNonSatisfyingPoll = true;
    // The backoff is bounded by the same wall: sleeping past it would spend
    // budget the terminal observation is holding.
    const idleBudgetMs = s2RemainingBudgetMs(hooks.now(), pollUntil);
    if (idleBudgetMs === 0) break;
    await hooks.sleep(Math.min(50, idleBudgetMs));
  }
  // Best-effort, bounded by the reserved slice, and never authoritative: a
  // transport failure here must be observed as an absent reading rather than
  // replacing the typed deadline refusal with a transport error. The budget is
  // still measured against the one absolute deadline; only the containment moved
  // into s2TerminalObservation, where an injected observer can prove it.
  const terminalBudgetMs = s2RemainingBudgetMs(hooks.now(), deadline);
  const observed = await s2TerminalObservation(
    () => hooks.observe(`${scenario}-deadline-observation`, terminalBudgetMs),
    terminalBudgetMs,
  );
  const terminalObservationDiff =
    observed === undefined
      ? "deadline-observation unavailable within the reserved terminal budget"
      : `pending=${observed.pending};delivered=${observed.delivered};` +
        `quarantined=${observed.quarantined};phase=${observed.last_phase}`;
  const pollObservationDiff = pollReadFailed
    ? "poll-read-failed"
    : sawNonSatisfyingPoll
      ? "poll-predicate-unsatisfied"
      : "poll-window-exhausted-without-status";
  hooks.emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: `${scenario}-deadline-observation`,
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: null,
    post_cursor: null,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    checkpoint_mode: "unsigned-v0",
    // An absent observation reports nulls rather than a fabricated status: the
    // age vocabulary has no "unobserved" member, so borrowing one would put a
    // reading in the receipt that was never taken.
    ...(observed === undefined
      ? {
          oldest_pending_age_ms: null,
          oldest_pending_age_status: null,
          oldest_pending_age_alert: null,
          oldest_pending_age_alert_threshold_ms: null,
        }
      : outboxAgeEvidence(observed)),
    ...receiptMetrics(),
    lock_wait_ms: null,
    retry_count: observed?.delivery_attempts ?? null,
    assertion_diff: `${pollObservationDiff};${terminalObservationDiff}`,
    status: "fail",
    // Measured, not asserted. The old constant claimed 8000 even when the
    // fresh-window polls had already carried the wait past it.
    duration_ms: Math.round(hooks.now() - startedAt),
  });
  return fail("S2_OUTBOX_DEADLINE_EXCEEDED");
}

async function waitForOutbox(
  scenario: string,
  predicate: (status: S2OutboxStatus) => boolean,
): Promise<S2OutboxStatus> {
  return s2WaitForOutbox(scenario, predicate);
}

async function expectTransportAbort(
  body: Record<string, unknown>,
  scenario: string,
): Promise<string> {
  const observationId = body.s2_harness_request_id;
  if (body.s2_abort_before_commit === true && typeof observationId !== "string") {
    fail("S2_ABORT_OBSERVATION_ID_MISSING");
  }
  try {
    await request("POST", "/__s2/write", scenario, body, 20);
  } catch (error) {
    if (error instanceof Error && error.message === "S2_TRANSPORT_ABORTED") {
      return typeof observationId === "string" ? observationId : "";
    }
    throw error;
  }
  return fail("S2_TRANSPORT_ABORT_EXPECTED");
}

async function assertReplay(
  problemId: string,
  expectedEvents: number,
  scenario: string,
): Promise<S2ReplayResult> {
  const replay = await request("POST", "/__s2/replay", scenario, { problem_id: problemId });
  assertEqual(replay.status, 200, "S2_PROJECTION_REPLAY_FAILED");
  const parsed = parseS2ReplayResult(replay.body);
  assertEqual(parsed.matches, true, "S2_PROJECTION_REPLAY_MISMATCH");
  assertEqual(parsed.cursor, expectedEvents, "S2_REPLAY_CURSOR_INVALID");
  assertEqual(parsed.event_count, expectedEvents, "S2_REPLAY_PAGE_COUNT_INVALID");
  return parsed;
}

async function exerciseOutboxDrainer(): Promise<void> {
  await seed(OUTBOX_PROBLEM, "outbox-seed");
  const before = await outboxStatus("outbox-before-auto-handoff", S2_OUTBOX_STATUS_TIMEOUT_MS);
  const auto = await write(
    writeBody(1, OUTBOX_PROBLEM, "Outbox automatic handoff claim."),
    "outbox-automatic-handoff",
    undefined,
    false,
  );
  assertEqual(auto.outbox_handoff, "armed", "S2_OUTBOX_HANDOFF_NOT_ARMED");
  // A completely drained queue is not alarm-free. The DO deliberately keeps a
  // five-minute idle reconcile alarm so a lost producer nudge cannot strand a
  // durable D1 row forever. Require that recovery authority to survive the
  // terminal delivery instead of waiting for the now-impossible null alarm.
  const afterAuto = await waitForOutbox(
    "outbox-auto-alarm-delivery",
    (status) =>
      status.delivered >= before.delivered + 1 &&
      status.pending === 0 &&
      hasIdleReconcileAlarm(status),
  );
  assertEqual(afterAuto.max_active, 1, "S2_OUTBOX_AUTO_SINGLE_OWNER_INVALID");
  const autoState = await state(OUTBOX_PROBLEM, "outbox-auto-visible-state");
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ] as const) {
    assertEqual(autoState.counts[table], 1, "S2_OUTBOX_AUTO_DUPLICATED_VISIBLE_ROW");
  }

  const scheduled = await write(
    {
      ...writeBody(2, OUTBOX_PROBLEM, "Outbox scheduled recovery claim."),
      s2_fail_outbox_nudge: true,
    },
    "outbox-failed-initial-handoff",
    undefined,
    false,
  );
  assertEqual(scheduled.outbox_handoff, "unavailable", "S2_OUTBOX_HANDOFF_FAILURE_NOT_PLANTED");
  const stranded = await outboxStatus("outbox-failed-handoff-visible", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(stranded.pending, 1, "S2_OUTBOX_FAILED_HANDOFF_NOT_PENDING");
  // The prior successful drain owns an idle-reconcile alarm. A failed nudge
  // must not replace or advance that existing authority; comparing the exact
  // baseline is causal, whereas requiring null became impossible once idle
  // reconciliation was added.
  assertEqual(stranded.alarm_at, afterAuto.alarm_at, "S2_OUTBOX_FAILED_HANDOFF_CHANGED_IDLE_ALARM");
  await triggerScheduledOutboxReconcile("outbox-scheduled-reconcile-trigger");
  const afterScheduled = await waitForOutbox(
    "outbox-scheduled-reconcile-delivery",
    (status) =>
      status.delivered >= afterAuto.delivered + 1 &&
      status.pending === 0 &&
      hasIdleReconcileAlarm(status),
  );

  const concurrent = await write(
    writeBody(3, OUTBOX_PROBLEM, "Outbox concurrent alarm claim."),
    "outbox-concurrent-write",
  );
  assertEqual(concurrent.outbox_handoff, "deferred", "S2_OUTBOX_DEFERRED_WRITE_INVALID");
  const nudges = await Promise.all(
    Array.from({ length: 12 }, () =>
      request("POST", "/__s2/outbox/nudge", "outbox-concurrent-alarm", { fault_mode: "none" }),
    ),
  );
  for (const nudge of nudges) assertEqual(nudge.status, 202, "S2_OUTBOX_NUDGE_FAILED");
  const afterConcurrent = await waitForOutbox(
    "outbox-concurrent-alarm-delivery",
    (status) => status.delivered >= afterScheduled.delivered + 1 && status.pending === 0,
  );
  assertEqual(afterConcurrent.max_active, 1, "S2_OUTBOX_CONCURRENT_OWNERSHIP_VIOLATION");
  assertEqual(afterConcurrent.active, 0, "S2_OUTBOX_ACTIVE_OWNER_LEAKED");

  const transient = await write(
    writeBody(4, OUTBOX_PROBLEM, "Outbox retry claim."),
    "outbox-retry-write",
  );
  const failOnce = await request("POST", "/__s2/outbox/drain", "outbox-rearm-backoff", {
    fault_mode: "fail-once",
  });
  assertEqual(failOnce.status, 200, "S2_OUTBOX_FAIL_ONCE_ROUTE_FAILED");
  const retryScheduled = numberAt(failOnce.body, "retry_scheduled_ms");
  assertEqual(retryScheduled >= 25 && retryScheduled <= 2_000, true, "S2_OUTBOX_BACKOFF_UNBOUNDED");
  const afterRetry = await waitForOutbox(
    "outbox-rearm-delivery",
    (status) => status.delivered >= afterConcurrent.delivered + 1 && status.pending === 0,
  );
  assertEqual(
    afterRetry.delivery_attempts >= before.delivery_attempts + 2,
    true,
    "S2_OUTBOX_NOT_AT_LEAST_ONCE",
  );
  assertEqual(transient.seq, 4, "S2_OUTBOX_RETRY_SEQUENCE_INVALID");

  const restored = await write(
    writeBody(5, OUTBOX_PROBLEM, "Outbox stale-wrap recovery claim."),
    "outbox-stale-wrap-write",
  );
  assertEqual(restored.outbox_handoff, "deferred", "S2_OUTBOX_STALE_WRAP_WRITE_NOT_DEFERRED");
  const staleWrap = await request(
    "POST",
    "/__s2/outbox/plant-stale-wrap",
    "outbox-stale-wrap-fixture",
    { scan_after_id: 1_000, scan_wrap_through_id: 2_000 },
  );
  assertEqual(staleWrap.status, 201, "S2_OUTBOX_STALE_WRAP_FIXTURE_FAILED");
  const staleFirst = await request("POST", "/__s2/outbox/drain", "outbox-stale-wrap-first-drain", {
    fault_mode: "none",
  });
  assertEqual(staleFirst.status, 200, "S2_OUTBOX_STALE_WRAP_FIRST_DRAIN_FAILED");
  assertEqual(numberAt(staleFirst.body, "delivered"), 0, "S2_OUTBOX_STALE_WRAP_SKIPPED_RANGE");
  const staleArmed = await outboxStatus("outbox-stale-wrap-rearmed", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(staleArmed.pending, 1, "S2_OUTBOX_STALE_WRAP_PENDING_LOST");
  assertEqual(staleArmed.alarm_at === null, false, "S2_OUTBOX_STALE_WRAP_ALARM_LOST");
  const staleSecond = await request(
    "POST",
    "/__s2/outbox/drain",
    "outbox-stale-wrap-second-drain",
    { fault_mode: "none" },
  );
  assertEqual(staleSecond.status, 200, "S2_OUTBOX_STALE_WRAP_SECOND_DRAIN_FAILED");
  assertEqual(numberAt(staleSecond.body, "delivered"), 1, "S2_OUTBOX_STALE_WRAP_NOT_DELIVERED");
  const staleReset = await request("POST", "/__s2/outbox/nudge", "outbox-stale-wrap-fault-reset", {
    fault_mode: "none",
  });
  assertEqual(staleReset.status, 202, "S2_OUTBOX_STALE_WRAP_FAULT_RESET_FAILED");
  await waitForOutbox(
    "outbox-stale-wrap-settled",
    (status) => status.pending === 0 && hasIdleReconcileAlarm(status),
  );
  assertEqual(restored.seq, 5, "S2_OUTBOX_STALE_WRAP_SEQUENCE_INVALID");

  const held = await write(
    writeBody(6, OUTBOX_PROBLEM, "Outbox kill-boundary claim."),
    "outbox-hold-before-ack-write",
  );
  const malformed = await write(
    writeBody(7, OUTBOX_PROBLEM, "Outbox malformed fixture claim."),
    "outbox-malformed-write",
  );
  const planted = await request(
    "POST",
    "/__s2/outbox/plant-malformed",
    "outbox-malformed-payload-negative",
    { event_id: malformed.event_id },
  );
  assertEqual(planted.status, 201, "S2_OUTBOX_MALFORMED_FIXTURE_FAILED");
  const hold = await request("POST", "/__s2/outbox/drain", "outbox-hold-before-ack", {
    fault_mode: "hold-before-ack",
  });
  assertEqual(hold.status, 200, "S2_OUTBOX_HOLD_ROUTE_FAILED");
  assertEqual(booleanAt(hold.body, "held_before_ack"), true, "S2_OUTBOX_HOLD_NOT_REACHED");
  const heldStatus = await outboxStatus("outbox-kill-boundary-status", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(heldStatus.last_phase, "held-before-ack", "S2_OUTBOX_KILL_BOUNDARY_NOT_DURABLE");
  assertEqual(heldStatus.alarm_at === null, false, "S2_OUTBOX_KILL_REARM_MISSING");
  assertEqual(held.seq, 6, "S2_OUTBOX_HOLD_SEQUENCE_INVALID");
}

async function plantLegacy(problemId: string, eventCount: number, scenario: string): Promise<void> {
  const planted = await request(
    "POST",
    "/__s2/legacy/plant",
    scenario,
    { problem_id: problemId, event_count: eventCount, created_at: CREATED_AT },
    20_000,
  );
  assertEqual(planted.status, 201, "S2_LEGACY_PLANT_FAILED");
  assertEqual(numberAt(planted.body, "planted"), eventCount, "S2_LEGACY_PLANT_COUNT_INVALID");
}

async function attemptLegacyBackfill(problemId: string, scenario: string): Promise<RequestResult> {
  return request(
    "POST",
    "/__s2/integrity/backfill",
    scenario,
    { problem_id: problemId, completed_at: CREATED_AT },
    20_000,
  );
}

function assertSuccessfulV2Backfill(result: RequestResult, code: string): void {
  assertEqual(result.status, 200, `${code}_FAILED`);
  assertEqual(stringAt(result.body, "status"), "complete", `${code}_STATUS_INVALID`);
  assertEqual(numberAt(result.body, "chain_version"), 2, `${code}_CHAIN_VERSION_INVALID`);
  assertEqual(
    stringAt(result.body, "checkpoint_mode"),
    "unsigned-v0",
    `${code}_CHECKPOINT_MODE_INVALID`,
  );
}

/**
 * Both sides of the bounded-replay limit, against real local D1.
 *
 * Over the limit the replay must refuse *and change nothing*: a second attempt refuses
 * identically and the problem's reads stay blocked, so no digest, checkpoint or backfill
 * state was written on the way to the refusal. At the limit it must complete in one batch,
 * producing a checkpoint per event and a chain head.
 */
async function legacyBoundedBackfill(): Promise<void> {
  await plantLegacy(LEGACY_OVER_LIMIT_PROBLEM, LEGACY_OVER_LIMIT_EVENTS, "legacy-over-limit-plant");

  const refused = await attemptLegacyBackfill(
    LEGACY_OVER_LIMIT_PROBLEM,
    "legacy-over-limit-backfill-refused",
  );
  assertEqual(refused.status, 409, "S2_LEGACY_OVER_LIMIT_NOT_REFUSED");
  assertEqual(
    stringAt(refused.body, "code"),
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_LEGACY_OVER_LIMIT_CODE_INVALID",
  );
  const refusedCounts = await counts(
    LEGACY_OVER_LIMIT_PROBLEM,
    "legacy-over-limit-counts-after-refusal",
  );
  assertEqual(refusedCounts.events, LEGACY_OVER_LIMIT_EVENTS, "S2_LEGACY_OVER_LIMIT_EVENTS_MUTATED");
  assertEqual(refusedCounts.event_chain_v2, 0, "S2_LEGACY_OVER_LIMIT_EVENT_CHAIN_V2_PARTIAL");
  assertEqual(
    refusedCounts.integrity_checkpoints,
    0,
    "S2_LEGACY_OVER_LIMIT_CHECKPOINT_PARTIAL",
  );
  assertEqual(
    refusedCounts.checkpoint_chain_v2,
    0,
    "S2_LEGACY_OVER_LIMIT_CHECKPOINT_CHAIN_V2_PARTIAL",
  );

  // Atomicity: refusing twice must be indistinguishable from refusing once.
  const refusedAgain = await attemptLegacyBackfill(
    LEGACY_OVER_LIMIT_PROBLEM,
    "legacy-over-limit-backfill-still-refused",
  );
  assertEqual(refusedAgain.status, 409, "S2_LEGACY_OVER_LIMIT_SECOND_NOT_REFUSED");
  assertEqual(
    stringAt(refusedAgain.body, "code"),
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_LEGACY_OVER_LIMIT_SECOND_CODE_INVALID",
  );
  const refusedAgainCounts = await counts(
    LEGACY_OVER_LIMIT_PROBLEM,
    "legacy-over-limit-counts-after-second-refusal",
  );
  assertEqual(
    JSON.stringify(refusedAgainCounts),
    JSON.stringify(refusedCounts),
    "S2_LEGACY_OVER_LIMIT_SECOND_REFUSAL_MUTATED_COUNTS",
  );

  // Nothing became readable: a partial replay would have unblocked the ledger.
  const blockedRead = await request(
    "GET",
    `/__s2/events?problem_id=${LEGACY_OVER_LIMIT_PROBLEM}&since=0&limit=10`,
    "legacy-over-limit-read-still-blocked",
  );
  assertEqual(blockedRead.status, 409, "S2_LEGACY_OVER_LIMIT_READ_NOT_BLOCKED");
  assertEqual(
    stringAt(blockedRead.body, "code"),
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_LEGACY_OVER_LIMIT_READ_CODE_INVALID",
  );

  // The positive boundary: one event fewer completes, so the refusal above is a limit and
  // not a blanket failure of the legacy path.
  await plantLegacy(LEGACY_AT_LIMIT_PROBLEM, LEGACY_AT_LIMIT_EVENTS, "legacy-at-limit-plant");
  const completed = await attemptLegacyBackfill(
    LEGACY_AT_LIMIT_PROBLEM,
    "legacy-at-limit-backfill-complete",
  );
  assertSuccessfulV2Backfill(completed, "S2_LEGACY_AT_LIMIT_BACKFILL");
  // This is the replay's `db.batch`, not the later ordinary write batch. A positive value
  // proves the backfill receipt preserves the D1 metadata instead of reporting only reads.
  assertEqual(
    numberAt(completed.body, "backfill_rows_written") > 0,
    true,
    "S2_LEGACY_AT_LIMIT_BACKFILL_BATCH_WRITES_UNMEASURED",
  );
  assertEqual(
    booleanAt(completed.body, "backfill_fast_path"),
    false,
    "S2_LEGACY_AT_LIMIT_BACKFILL_WRONGLY_FAST_PATH",
  );

  const upgraded = await state(LEGACY_AT_LIMIT_PROBLEM, "legacy-at-limit-state");
  assertEqual(upgraded.cursor, LEGACY_AT_LIMIT_EVENTS, "S2_LEGACY_AT_LIMIT_CURSOR_INVALID");
  assertEqual(
    upgraded.counts.integrity_checkpoints,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_CHECKPOINTS_INVALID",
  );
  assertEqual(
    upgraded.counts.event_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_EVENT_CHAIN_V2_INVALID",
  );
  assertEqual(
    upgraded.counts.checkpoint_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_CHECKPOINT_CHAIN_V2_INVALID",
  );
  assertEqual(
    upgraded.checkpoint_mode,
    "unsigned-v0",
    "S2_LEGACY_AT_LIMIT_CHECKPOINT_MODE_INVALID",
  );
  // The ledger is readable again, which is the property the upgrade exists to restore: the
  // same read returned 409 for the over-limit twin. Projection replay is deliberately not
  // asserted here — the fixture plants event envelopes, which is what integrity backfill
  // operates on, and not claim projections, which have their own coverage on the primary
  // problems above.
  const pageSize = 200;
  const firstPage = await request(
    "GET",
    `/__s2/events?problem_id=${LEGACY_AT_LIMIT_PROBLEM}&since=0&limit=${pageSize}`,
    "legacy-at-limit-read-unblocked",
  );
  assertEqual(firstPage.status, 200, "S2_LEGACY_AT_LIMIT_READ_BLOCKED");
  assertEqual(
    Array.isArray(firstPage.body.events) ? (firstPage.body.events as unknown[]).length : -1,
    pageSize,
    "S2_LEGACY_AT_LIMIT_FIRST_PAGE_INVALID",
  );
  // The tail is present too, so the upgrade reached the last envelope and not just the head.
  const tail = await request(
    "GET",
    `/__s2/events?problem_id=${LEGACY_AT_LIMIT_PROBLEM}&since=500&limit=${pageSize}`,
    "legacy-at-limit-read-tail",
  );
  assertEqual(tail.status, 200, "S2_LEGACY_AT_LIMIT_TAIL_BLOCKED");
  assertEqual(
    Array.isArray(tail.body.events) ? (tail.body.events as unknown[]).length : -1,
    LEGACY_AT_LIMIT_EVENTS - 500,
    "S2_LEGACY_AT_LIMIT_TAIL_INVALID",
  );
}

/**
 * The bounded-replay limit belongs to the legacy upgrade, not to ordinary writing.
 *
 * Every write calls the same integrity function, so while the size check ran ahead of the
 * "already complete" early return, a healthy fully-digested problem became permanently
 * unwritable the moment it passed 512 events: the 513th write succeeded and every later one
 * was refused with KRATER_INTEGRITY_BACKFILL_REQUIRED, naming a replay that had already
 * completed and that would itself refuse at that size. These writes cross that boundary on a
 * problem whose upgrade is finished, and must all be accepted.
 */
async function ordinaryWritesPastTheLimit(): Promise<void> {
  await plantLegacy(
    LEGACY_WRITE_BOUNDARY_PROBLEM,
    LEGACY_AT_LIMIT_EVENTS,
    "legacy-write-boundary-plant",
  );
  const upgraded = await attemptLegacyBackfill(
    LEGACY_WRITE_BOUNDARY_PROBLEM,
    "legacy-write-boundary-backfill",
  );
  assertSuccessfulV2Backfill(upgraded, "S2_WRITE_BOUNDARY_BACKFILL");

  // 513th event: allowed even before the fix, because the limit was not yet exceeded.
  const crossing = await request(
    "POST",
    "/__s2/write",
    "legacy-write-boundary-crossing-write",
    {
      problem_id: LEGACY_WRITE_BOUNDARY_PROBLEM,
      claim_id: "C-write-boundary-513",
      event_id: "E-write-boundary-513",
      idempotency_key: "IK-write-boundary-513",
      statement: "The write that takes an upgraded problem past the replay limit.",
      created_at: CREATED_AT,
    },
    20_000,
  );
  assertEqual(crossing.status, 200, "S2_WRITE_BOUNDARY_CROSSING_WRITE_REFUSED");

  // 514th event: this is the one the ordering defect refused, permanently.
  const beyond = await request(
    "POST",
    "/__s2/write",
    "legacy-write-boundary-write-beyond-limit",
    {
      problem_id: LEGACY_WRITE_BOUNDARY_PROBLEM,
      claim_id: "C-write-boundary-514",
      event_id: "E-write-boundary-514",
      idempotency_key: "IK-write-boundary-514",
      statement: "An upgraded problem keeps accepting writes beyond the replay limit.",
      created_at: CREATED_AT,
    },
    20_000,
  );
  assertEqual(beyond.status, 200, "S2_WRITE_BOUNDARY_WRITE_BEYOND_LIMIT_REFUSED");
  assertEqual(
    numberAt(beyond.body, "post_cursor"),
    LEGACY_AT_LIMIT_EVENTS + 2,
    "S2_WRITE_BOUNDARY_CURSOR_INVALID",
  );
}

/**
 * The completeness check must still notice a single undigested envelope in an otherwise
 * upgraded log.
 *
 * Deciding "already upgraded" used to materialize every envelope and walk them with
 * `.every()`; it now asks whether any undigested envelope exists and stops at the first one.
 * Those two agree trivially on an all-digested or an all-NULL log — the only shape that can
 * tell them apart is a mixed one. So this plants a completed problem, appends one undigested
 * envelope behind its back, and requires the same refusal the exhaustive walk produced:
 * partial integrity state is never mistaken for a finished upgrade.
 */
async function mixedDigestLogIsNotComplete(): Promise<void> {
  await plantLegacy(LEGACY_MIXED_PROBLEM, 8, "legacy-mixed-plant");
  const upgraded = await attemptLegacyBackfill(LEGACY_MIXED_PROBLEM, "legacy-mixed-backfill");
  assertSuccessfulV2Backfill(upgraded, "S2_MIXED_BACKFILL");

  // One undigested envelope appended to a log the backfill row still calls complete.
  const appended = await request(
    "POST",
    "/__s2/legacy/plant",
    "legacy-mixed-append-undigested",
    { problem_id: LEGACY_MIXED_PROBLEM, event_count: 1, created_at: CREATED_AT, append: true },
    20_000,
  );
  assertEqual(appended.status, 201, "S2_MIXED_APPEND_FAILED");

  const write = await request(
    "POST",
    "/__s2/write",
    "legacy-mixed-write-refused",
    {
      problem_id: LEGACY_MIXED_PROBLEM,
      claim_id: "C-mixed-1",
      event_id: "E-mixed-1",
      idempotency_key: "IK-mixed-1",
      statement: "A write must not proceed while one envelope is undigested.",
      created_at: CREATED_AT,
    },
    20_000,
  );
  assertEqual(write.status, 409, "S2_MIXED_WRITE_NOT_REFUSED");
  assertEqual(
    stringAt(write.body, "code"),
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_MIXED_WRITE_CODE_INVALID",
  );

  const read = await request(
    "GET",
    `/__s2/events?problem_id=${LEGACY_MIXED_PROBLEM}&since=0&limit=10`,
    "legacy-mixed-read-blocked",
  );
  assertEqual(read.status, 409, "S2_MIXED_READ_NOT_BLOCKED");
}

/**
 * The completeness probe runs on every write, and its cost depends entirely on whether the
 * engine uses the partial index migration 0005 adds. A comment saying so is not evidence, and
 * the failure mode is silent: edit either the probe's WHERE clause or the index predicate so
 * they no longer imply one another and SQLite quietly reverts to searching the problem's whole
 * log, with every existing test still green.
 *
 * So the plan itself is asserted, on the path that matters — a healthy problem with no
 * undigested envelope, where the engine has to prove a negative. The harness sends a problem
 * id; the statement being explained is the same constant the probe executes.
 */
async function readProbePlan(
  problemId: string,
  scenario: string,
): Promise<Record<string, unknown>> {
  const plan = await request("GET", `/__s2/integrity/probe-plan?problem_id=${problemId}`, scenario);
  assertEqual(plan.status, 200, "S2_PROBE_PLAN_READ_FAILED");
  return plan.body;
}

/** Every assertion that the plan is the indexed one, so the three call sites cannot drift. */
function assertIndexedProbePlan(plan: Record<string, unknown>): void {
  assertEqual(booleanAt(plan, "uses_index"), true, "S2_PROBE_PLAN_INDEX_UNUSED");
  assertEqual(booleanAt(plan, "avoids_table_scan"), true, "S2_PROBE_PLAN_FULL_SCAN");
  // The exact step, not just "mentions the index": a plan that named the index while adding a
  // sort or a second loop would still satisfy the weaker checks above.
  assertEqual(
    booleanAt(plan, "matches_expected_search"),
    true,
    "S2_PROBE_PLAN_SEARCH_DETAIL_UNEXPECTED",
  );
  assertEqual(
    stringAt(plan, "index_name"),
    "events_undigested_idx",
    "S2_PROBE_PLAN_INDEX_NAME_INVALID",
  );
  assertEqual(
    Array.isArray(plan.steps) && plan.steps.length === 1,
    true,
    "S2_PROBE_PLAN_NOT_SINGLE_STEP",
  );
}

async function probePlanUsesPartialIndex(): Promise<void> {
  assertIndexedProbePlan(
    await readProbePlan(LEGACY_AT_LIMIT_PROBLEM, "integrity-probe-plan-uses-partial-index"),
  );

  // And the problem really is the no-match case: it is writable, which the completeness
  // probe only permits when it finds no undigested envelope.
  const healthy = await state(LEGACY_AT_LIMIT_PROBLEM, "integrity-probe-plan-healthy-subject");
  assertEqual(
    healthy.counts.integrity_checkpoints,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_PROBE_PLAN_SUBJECT_NOT_UPGRADED",
  );
  assertEqual(
    healthy.counts.event_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_PROBE_PLAN_EVENT_CHAIN_V2_INCOMPLETE",
  );
  assertEqual(
    healthy.counts.checkpoint_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_PROBE_PLAN_CHECKPOINT_CHAIN_V2_INCOMPLETE",
  );
}

/**
 * What the write preflight actually costs, measured on two upgraded problems whose histories
 * differ 64-fold.
 *
 * The receipt distinguishes the measured preflight from the measured write batch, and its
 * end-to-end wall time starts before validation. The completeness check that runs before every
 * write — the thing migration 0005 exists to bound — is therefore evidence rather than an
 * omitted cost. A plan assertion says the index is chosen; this says what choosing it is worth.
 *
 * The claim is bounded, not constant: preflight rows stay under a small ceiling while the log
 * behind them grows from 8 envelopes to 512, so the cost does not track ledger size. Nothing
 * here measures deployed D1, and a seek into a B-tree is not O(1).
 */
async function preflightCostDoesNotGrowWithHistory(): Promise<void> {
  for (const [problemId, events, scenario] of [
    [PREFLIGHT_SMALL_PROBLEM, PREFLIGHT_SMALL_EVENTS, "preflight-small-plant"],
    [PREFLIGHT_LARGE_PROBLEM, PREFLIGHT_LARGE_EVENTS, "preflight-large-plant"],
  ] as const) {
    await plantLegacy(problemId, events, scenario);
    const upgraded = await attemptLegacyBackfill(problemId, `${scenario}-backfill`);
    assertSuccessfulV2Backfill(upgraded, "S2_PREFLIGHT_SUBJECT_BACKFILL");
  }

  const measured: Record<string, number> = {};
  for (const [problemId, events, scenario] of [
    [PREFLIGHT_SMALL_PROBLEM, PREFLIGHT_SMALL_EVENTS, "preflight-cost-small-history"],
    [PREFLIGHT_LARGE_PROBLEM, PREFLIGHT_LARGE_EVENTS, "preflight-cost-large-history"],
  ] as const) {
    const result = await write(
      writeBody(events + 1, problemId, "Preflight cost measurement claim."),
      scenario,
    );
    assertEqual(result.post_cursor, events + 1, "S2_PREFLIGHT_CURSOR_INVALID");

    // The fast path is the one under test. A false here would mean the write re-ran the bounded
    // replay, and its rows would say nothing about the probe.
    assertEqual(result.preflight_fast_path, true, "S2_PREFLIGHT_NOT_FAST_PATH");
    // Head, backfill row, probe. Identical for both, so any cost difference between them can
    // only come from rows read, never from a different number of round trips.
    assertEqual(result.preflight_statements, 3, "S2_PREFLIGHT_STATEMENT_COUNT_INVALID");

    const preflightRows = result.preflight_rows_read;
    assertEqual(preflightRows <= PREFLIGHT_ROWS_CEILING, true, "S2_PREFLIGHT_ROWS_UNBOUNDED");
    // Healthy no-match preflights are read-only. The legacy replay's `db.batch` writes are
    // separately accounted in `preflight_rows_written`, so this assertion would fail if the
    // ordinary write path re-ran a backfill.
    assertEqual(result.preflight_rows_written, 0, "S2_PREFLIGHT_FAST_PATH_WROTE_ROWS");
    // These are exact subtotals, not an invented overall row count: `.first()` callers do not
    // expose D1 metadata, so combining them with either subtotal would be misleading.
    assertEqual(
      result.write_claim_wall_ms >= result.preflight_wall_ms,
      true,
      "S2_PREFLIGHT_WRITE_CLAIM_BEFORE_PREFLIGHT",
    );
    assertEqual(
      result.write_claim_wall_ms >= result.write_phase_ms,
      true,
      "S2_PREFLIGHT_WRITE_CLAIM_BEFORE_WRITE_PHASE",
    );
    measured[problemId] = preflightRows;
  }

  const small = measured[PREFLIGHT_SMALL_PROBLEM] ?? -1;
  const large = measured[PREFLIGHT_LARGE_PROBLEM] ?? -1;
  assertEqual(small >= 0 && large >= 0, true, "S2_PREFLIGHT_MEASUREMENT_MISSING");
  // 64x the history must not cost measurably more. Without the index the large problem's probe
  // reads its whole log to prove no envelope is undigested, and this is the assertion that
  // fails.
  assertEqual(large <= small + 1, true, "S2_PREFLIGHT_ROWS_GREW_WITH_HISTORY");
}

/** The refusal must survive a restart: it is a property of the data, not of a warm process. */
async function legacyBoundedBackfillAfterRestart(): Promise<void> {
  const refused = await attemptLegacyBackfill(
    LEGACY_OVER_LIMIT_PROBLEM,
    "legacy-over-limit-backfill-refused-after-restart",
  );
  assertEqual(refused.status, 409, "S2_LEGACY_OVER_LIMIT_RESTART_NOT_REFUSED");
  assertEqual(
    stringAt(refused.body, "code"),
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_LEGACY_OVER_LIMIT_RESTART_CODE_INVALID",
  );
  const blockedRead = await request(
    "GET",
    `/__s2/events?problem_id=${LEGACY_OVER_LIMIT_PROBLEM}&since=0&limit=10`,
    "legacy-over-limit-read-blocked-after-restart",
  );
  assertEqual(blockedRead.status, 409, "S2_LEGACY_OVER_LIMIT_RESTART_READ_NOT_BLOCKED");

  // And the completed neighbour is still complete, so the restart did not simply break reads.
  const upgraded = await state(LEGACY_AT_LIMIT_PROBLEM, "legacy-at-limit-state-after-restart");
  assertEqual(
    upgraded.counts.integrity_checkpoints,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_RESTART_CHECKPOINTS_INVALID",
  );
  assertEqual(
    upgraded.counts.event_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_RESTART_EVENT_CHAIN_V2_INVALID",
  );
  assertEqual(
    upgraded.counts.checkpoint_chain_v2,
    LEGACY_AT_LIMIT_EVENTS,
    "S2_LEGACY_AT_LIMIT_RESTART_CHECKPOINT_CHAIN_V2_INVALID",
  );

  // The write boundary has to hold across a restart too. Exercising it only in a warm
  // process would miss a freeze that reappears once the integrity state is re-read from D1
  // rather than from anything the previous process had already touched: the refusal this
  // regression guards was a property of stored event count, so a cold worker is exactly
  // where it would come back.
  const boundary = await state(
    LEGACY_WRITE_BOUNDARY_PROBLEM,
    "legacy-write-boundary-state-after-restart",
  );
  assertEqual(
    boundary.cursor,
    LEGACY_AT_LIMIT_EVENTS + 2,
    "S2_WRITE_BOUNDARY_RESTART_CURSOR_INVALID",
  );
  assertEqual(
    boundary.counts.integrity_checkpoints,
    LEGACY_AT_LIMIT_EVENTS + 2,
    "S2_WRITE_BOUNDARY_RESTART_CHECKPOINTS_INVALID",
  );
  assertEqual(
    boundary.counts.event_chain_v2,
    LEGACY_AT_LIMIT_EVENTS + 2,
    "S2_WRITE_BOUNDARY_RESTART_EVENT_CHAIN_V2_INVALID",
  );
  assertEqual(
    boundary.counts.checkpoint_chain_v2,
    LEGACY_AT_LIMIT_EVENTS + 2,
    "S2_WRITE_BOUNDARY_RESTART_CHECKPOINT_CHAIN_V2_INVALID",
  );

  const beyond = await request(
    "POST",
    "/__s2/write",
    "legacy-write-boundary-write-after-restart",
    {
      problem_id: LEGACY_WRITE_BOUNDARY_PROBLEM,
      claim_id: "C-write-boundary-515",
      event_id: "E-write-boundary-515",
      idempotency_key: "IK-write-boundary-515",
      statement: "A cold worker still accepts writes beyond the replay limit.",
      created_at: CREATED_AT,
    },
    20_000,
  );
  assertEqual(beyond.status, 200, "S2_WRITE_BOUNDARY_RESTART_WRITE_REFUSED");
  assertEqual(
    numberAt(beyond.body, "post_cursor"),
    LEGACY_AT_LIMIT_EVENTS + 3,
    "S2_WRITE_BOUNDARY_RESTART_CURSOR_ADVANCE_INVALID",
  );
}

type UpgradeEvidenceLane = "raw-sql" | "migration-journal";

function upgradeScenario(
  lane: UpgradeEvidenceLane,
  stage: "existing" | "indexed" | "empty",
): string {
  if (lane === "migration-journal") {
    if (stage === "existing") return "legacy-0001-current-migration-journal-backfill-tamper-replay";
    if (stage === "indexed") return "current-migration-journal-indexed-healthy-write-replay";
    return "legacy-0001-current-migration-journal-empty-write-replay";
  }
  if (stage === "existing") return "raw-sql-0004-existing-event-backfill-tamper-replay";
  if (stage === "indexed") return "raw-sql-0005-indexed-healthy-write-replay";
  return "raw-sql-0004-empty-database-fresh-write-replay";
}

async function upgradeExisting(lane: UpgradeEvidenceLane = "raw-sql"): Promise<void> {
  const preBackfillRead = await request(
    "GET",
    `/__s2/events?problem_id=${UPGRADE_EXISTING_PROBLEM}&since=0&limit=200`,
    "upgrade-existing-backfill-required",
  );
  assertEqual(preBackfillRead.status, 409, "S2_UPGRADE_EXISTING_READ_NOT_BLOCKED");
  assertEqual(
    preBackfillRead.body.code,
    "KRATER_INTEGRITY_BACKFILL_REQUIRED",
    "S2_UPGRADE_EXISTING_BACKFILL_CODE_INVALID",
  );
  assertEqual(
    preBackfillRead.contentType.startsWith("application/problem+json"),
    true,
    "S2_UPGRADE_EXISTING_BACKFILL_MEDIA_INVALID",
  );

  const firstBackfill = await request(
    "POST",
    "/__s2/integrity/backfill",
    "upgrade-existing-bounded-backfill",
    { problem_id: UPGRADE_EXISTING_PROBLEM, completed_at: CREATED_AT },
  );
  assertSuccessfulV2Backfill(firstBackfill, "S2_UPGRADE_EXISTING_BACKFILL");
  assertEqual(
    numberAt(firstBackfill.body, "backfill_rows_written") > 0,
    true,
    "S2_UPGRADE_EXISTING_BACKFILL_BATCH_WRITES_UNMEASURED",
  );
  assertEqual(
    firstBackfill.body.checkpoint_mode,
    "unsigned-v0",
    "S2_UPGRADE_EXISTING_CHECKPOINT_MODE_INVALID",
  );
  const secondBackfill = await request(
    "POST",
    "/__s2/integrity/backfill",
    "upgrade-existing-backfill-idempotence",
    { problem_id: UPGRADE_EXISTING_PROBLEM, completed_at: CREATED_AT },
  );
  assertSuccessfulV2Backfill(secondBackfill, "S2_UPGRADE_EXISTING_BACKFILL_RERUN");

  const restored = await state(UPGRADE_EXISTING_PROBLEM, "upgrade-existing-restored-state");
  assertEqual(restored.cursor, 1, "S2_UPGRADE_EXISTING_CURSOR_INVALID");
  assertEqual(restored.counts.events, 1, "S2_UPGRADE_EXISTING_EVENT_COUNT_INVALID");
  assertEqual(restored.counts.event_chain_v2, 1, "S2_UPGRADE_EXISTING_EVENT_CHAIN_V2_INVALID");
  assertEqual(
    restored.counts.integrity_checkpoints,
    1,
    "S2_UPGRADE_EXISTING_CHECKPOINT_COUNT_INVALID",
  );
  assertEqual(
    restored.counts.checkpoint_chain_v2,
    1,
    "S2_UPGRADE_EXISTING_CHECKPOINT_CHAIN_V2_INVALID",
  );
  assertEqual(restored.checkpoint_mode, "unsigned-v0", "S2_UPGRADE_EXISTING_MODE_INVALID");
  await assertReplay(UPGRADE_EXISTING_PROBLEM, 1, "upgrade-existing-replay-after-backfill");

  const tamper = await request(
    "POST",
    "/__s2/tamper-envelope",
    "upgrade-existing-post-backfill-tamper",
    { event_id: "E-upgrade-existing-001", operation: "update" },
  );
  assertEqual(tamper.status, 409, "S2_UPGRADE_EXISTING_TAMPER_NOT_REFUSED");
  assertEqual(
    tamper.body.code,
    "EVENT_ENVELOPE_IMMUTABLE",
    "S2_UPGRADE_EXISTING_TAMPER_CODE_INVALID",
  );
  await assertReplay(UPGRADE_EXISTING_PROBLEM, 1, "upgrade-existing-replay-after-tamper");

  const appended = await write(
    writeBody(2, UPGRADE_EXISTING_PROBLEM, "Post-upgrade integrity claim."),
    "upgrade-existing-post-backfill-write",
  );
  assertEqual(appended.seq, 2, "S2_UPGRADE_EXISTING_APPEND_SEQUENCE_INVALID");
  await assertReplay(UPGRADE_EXISTING_PROBLEM, 2, "upgrade-existing-post-upgrade-replay");

  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1-upgrade",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: upgradeScenario(lane, "existing"),
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: appended.event_id,
    pre_cursor: 1,
    post_cursor: 2,
    payload_sha256: appended.payload_sha256,
    row_digest: appended.row_digest,
    build_digest: appended.build_digest,
    checkpoint_digest: appended.checkpoint_digest,
    checkpoint_mode: "unsigned-v0",
    ...receiptMetrics(appended),
    lock_wait_ms: appended.lock_wait_ms,
    retry_count: appended.retry_count,
    assertion_diff: null,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

/**
 * In the raw-SQL lane, this follows the observed 0004 -> 0005 transition on the same persisted
 * database, so it proves that an already backfilled legacy subject takes the indexed healthy
 * no-match preflight before its next ordinary write. The migration-journal caller starts only
 * after the complete journal is applied; there it proves final indexed behavior, not the raw
 * one-migration transition.
 */
async function upgradeIndexed(lane: UpgradeEvidenceLane = "raw-sql"): Promise<void> {
  assertIndexedProbePlan(
    await readProbePlan(UPGRADE_EXISTING_PROBLEM, "upgrade-indexed-probe-plan"),
  );

  const appended = await write(
    writeBody(3, UPGRADE_EXISTING_PROBLEM, "Post-0005 indexed integrity claim."),
    "upgrade-indexed-post-migration-write",
  );
  assertEqual(appended.seq, 3, "S2_UPGRADE_INDEXED_APPEND_SEQUENCE_INVALID");
  assertEqual(appended.preflight_fast_path, true, "S2_UPGRADE_INDEXED_NOT_FAST_PATH");
  assertEqual(
    appended.preflight_statements,
    3,
    "S2_UPGRADE_INDEXED_PREFLIGHT_STATEMENT_COUNT_INVALID",
  );
  assertEqual(
    appended.preflight_rows_written,
    0,
    "S2_UPGRADE_INDEXED_HEALTHY_PREFLIGHT_WROTE_ROWS",
  );
  await assertReplay(UPGRADE_EXISTING_PROBLEM, 3, "upgrade-indexed-post-migration-replay");

  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1-upgrade",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: upgradeScenario(lane, "indexed"),
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: appended.event_id,
    pre_cursor: 2,
    post_cursor: 3,
    payload_sha256: appended.payload_sha256,
    row_digest: appended.row_digest,
    build_digest: appended.build_digest,
    checkpoint_digest: appended.checkpoint_digest,
    checkpoint_mode: "unsigned-v0",
    ...receiptMetrics(appended),
    lock_wait_ms: appended.lock_wait_ms,
    retry_count: appended.retry_count,
    assertion_diff: null,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

async function upgradeEmpty(lane: UpgradeEvidenceLane = "raw-sql"): Promise<void> {
  await seed(UPGRADE_EMPTY_PROBLEM, "upgrade-empty-old-database-seed");
  const appended = await write(
    writeBody(1, UPGRADE_EMPTY_PROBLEM, "Fresh claim after an empty legacy database upgrade."),
    "upgrade-empty-post-migration-write",
  );
  assertEqual(appended.seq, 1, "S2_UPGRADE_EMPTY_SEQUENCE_INVALID");
  const upgraded = await state(UPGRADE_EMPTY_PROBLEM, "upgrade-empty-post-migration-state");
  assertEqual(upgraded.cursor, 1, "S2_UPGRADE_EMPTY_CURSOR_INVALID");
  assertEqual(upgraded.counts.event_chain_v2, 1, "S2_UPGRADE_EMPTY_EVENT_CHAIN_V2_INVALID");
  assertEqual(upgraded.counts.integrity_checkpoints, 1, "S2_UPGRADE_EMPTY_CHECKPOINT_INVALID");
  assertEqual(
    upgraded.counts.checkpoint_chain_v2,
    1,
    "S2_UPGRADE_EMPTY_CHECKPOINT_CHAIN_V2_INVALID",
  );
  await assertReplay(UPGRADE_EMPTY_PROBLEM, 1, "upgrade-empty-post-migration-replay");
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1-upgrade",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: upgradeScenario(lane, "empty"),
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: appended.event_id,
    pre_cursor: 0,
    post_cursor: 1,
    payload_sha256: appended.payload_sha256,
    row_digest: appended.row_digest,
    build_digest: appended.build_digest,
    checkpoint_digest: appended.checkpoint_digest,
    checkpoint_mode: "unsigned-v0",
    ...receiptMetrics(appended),
    lock_wait_ms: appended.lock_wait_ms,
    retry_count: appended.retry_count,
    assertion_diff: null,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

async function exercise(): Promise<void> {
  const writes: S2SettledWriteResult[] = [];
  await seed(PRIMARY_PROBLEM, "seed-primary");

  const first = await write(writeBody(1), "first-write");
  assertEqual(first.seq, 1, "S2_FIRST_SEQUENCE_INVALID");
  assertEqual(first.idempotent, false, "S2_FIRST_WRITE_MARKED_IDEMPOTENT");
  assertEqual(first.pre_cursor, 0, "S2_FIRST_PRE_CURSOR_INVALID");
  assertEqual(first.post_cursor, 1, "S2_FIRST_POST_CURSOR_INVALID");
  writes.push(selectedSettledWrite(first));

  const sameKey = await Promise.all(
    Array.from({ length: 12 }, () => write(writeBody(1), "same-key-concurrency")),
  );
  for (const entry of sameKey) {
    assertEqual(entry.seq, 1, "S2_SAME_KEY_SEQUENCE_INVALID");
    assertEqual(entry.idempotent, true, "S2_SAME_KEY_REPLAY_NOT_IDEMPOTENT");
  }

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, offset) =>
      write(writeBody(offset + 2), "chain-head-contention"),
    ),
  );
  const sequences = concurrent.map((entry) => entry.seq).sort((left, right) => left - right);
  assertEqual(sequences.join(","), "2,3,4,5,6,7,8,9,10,11,12,13", "S2_SEQUENCE_INVALID");
  writes.push(...concurrent.map(selectedSettledWrite));

  await deterministicAllocationAndRollback();

  await seed(SECONDARY_PROBLEM, "seed-secondary");
  const secondary = await write(
    writeBody(1, SECONDARY_PROBLEM, "Secondary problem claim."),
    "per-problem-sequence",
  );
  assertEqual(secondary.seq, 1, "S2_SECONDARY_SEQUENCE_INVALID");
  writes.push(selectedSettledWrite(secondary));

  const primaryState = await state(PRIMARY_PROBLEM, "cursor-and-row-counts");
  assertEqual(primaryState.cursor, 13, "S2_PRIMARY_CURSOR_INVALID");
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "idempotency",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ]) {
    assertEqual(primaryState.counts[table], 13, "S2_PRIMARY_ROW_COUNT_INVALID");
  }
  if (primaryState.checkpoint_digest === null) fail("S2_CHECKPOINT_MISSING");
  assertEqual(primaryState.checkpoint_mode, "unsigned-v0", "S2_CHECKPOINT_MODE_INVALID");
  const secondaryState = await state(SECONDARY_PROBLEM, "per-problem-cursor");
  assertEqual(secondaryState.cursor, 1, "S2_SECONDARY_CURSOR_INVALID");

  const events = await request(
    "GET",
    `/__s2/events?problem_id=${PRIMARY_PROBLEM}&since=0&limit=200`,
    "cursor-read",
  );
  assertEqual(events.status, 200, "S2_CURSOR_READ_FAILED");
  const eventPage = parseS2EventPageResult(events.body);
  if (eventPage.sequences.length !== 13 || eventPage.nextCursor !== 13 || eventPage.hasMore) {
    fail("S2_EVENT_PAGE_INVALID");
  }
  const terminalWrite = concurrent.find((entry) => entry.seq === 13);
  const terminalEvent = eventPage.events.find((entry) => entry.seq === 13);
  if (terminalWrite === undefined || terminalEvent === undefined) {
    fail("S2_TERMINAL_INTEGRITY_EVIDENCE_MISSING");
  }

  // Every write above deliberately deferred its outbox nudge so this phase can
  // inspect the durable queue before the real DO drainer runs. FTS is an async
  // outbox projection, not part of the canonical D1 write batch, so the honest
  // pre-rebuild state is an empty index. Requiring 13 here encoded the retired
  // synchronous-index design and made the real D1 harness fail despite correct
  // deferred delivery. The rebuild below is the positive FTS5 assertion.
  const fts = await request("GET", "/__s2/search?q=Synthetic&limit=20", "fts-deferred-read");
  assertEqual(fts.status, 200, "S2_DEFERRED_FTS_QUERY_FAILED");
  const ftsMatches = fts.body.matches;
  if (!Array.isArray(ftsMatches) || ftsMatches.length !== 0) {
    fail("S2_DEFERRED_FTS_STATE_INVALID");
  }

  const malformedFts = await request(
    "GET",
    "/__s2/search?q=%22&limit=10",
    "malformed-fts-negative",
  );
  assertEqual(malformedFts.status, 400, "S2_MALFORMED_FTS_STATUS_INVALID");
  assertEqual(
    malformedFts.contentType.startsWith("application/problem+json"),
    true,
    "S2_MALFORMED_FTS_MEDIA_INVALID",
  );
  assertEqual(malformedFts.body.code, "KRATER_READ_INVALID", "S2_MALFORMED_FTS_CODE_INVALID");
  for (const field of ["type", "title", "detail", "rule", "fix_hint", "schema"] as const) {
    stringAt(malformedFts.body, field);
  }
  asRecord(malformedFts.body.example);

  const rebuiltFts = await request("POST", "/__s2/rebuild-fts", "fts-rebuild", {
    problem_id: PRIMARY_PROBLEM,
  });
  assertEqual(rebuiltFts.status, 200, "S2_FTS_REBUILD_FAILED");
  const rebuiltSearch = await request(
    "GET",
    "/__s2/search?q=Synthetic&limit=20",
    "fts-rebuild-read",
  );
  const rebuiltMatches = rebuiltSearch.body.matches;
  if (!Array.isArray(rebuiltMatches) || rebuiltMatches.length !== 13) {
    fail("S2_FTS_REBUILD_RESULT_INVALID");
  }

  const primaryReplay = await assertReplay(PRIMARY_PROBLEM, 13, "replay-primary");
  assertS2TerminalDigestParity(terminalWrite, terminalEvent, primaryState, primaryReplay);
  await assertReplay(SECONDARY_PROBLEM, 1, "replay-secondary");

  for (const operation of ["update", "delete"] as const) {
    const tamper = await request(
      "POST",
      "/__s2/tamper-envelope",
      `envelope-${operation}-negative`,
      {
        event_id: "E-s2-001",
        operation,
      },
    );
    assertEqual(tamper.status, 409, "S2_ENVELOPE_TAMPER_STATUS_INVALID");
    assertEqual(tamper.body.code, "EVENT_ENVELOPE_IMMUTABLE", "S2_ENVELOPE_TAMPER_CODE_INVALID");
  }

  const redaction = await request("POST", "/__s2/redact-content", "lawful-content-redaction", {
    event_id: "E-s2-001",
    reason: "privacy",
    redacted_at: CREATED_AT,
  });
  assertEqual(redaction.status, 200, "S2_CONTENT_REDACTION_FAILED");
  await assertReplay(PRIMARY_PROBLEM, 13, "replay-after-redaction");

  const preFaultState = await state(PRIMARY_PROBLEM, "transaction-fault-pre-state");
  const fault = await request("POST", "/__s2/write", "transaction-fault-negative", {
    ...writeBody(14, PRIMARY_PROBLEM, "Synthetic conflicting claim."),
    claim_id: "C-s2-001",
  });
  assertEqual(fault.status, 409, "S2_PLANTED_TRANSACTION_FAULT_NOT_REJECTED");
  assertEqual(fault.body.code, "KRATER_WRITE_FAILED", "S2_PLANTED_TRANSACTION_FAULT_CODE_INVALID");
  const postFaultState = await state(PRIMARY_PROBLEM, "transaction-fault-post-state");
  assertEqual(
    canonicalState(postFaultState),
    canonicalState(preFaultState),
    "S2_FAULT_PARTIAL_COMMIT",
  );

  const beforeDisconnect = {
    ...writeBody(14),
    s2_abort_before_commit: true,
    s2_harness_request_id: "AB-s2-before-commit-001",
    s2_pre_commit_delay_ms: 125,
  };
  const beforeDisconnectObservationId = await expectTransportAbort(
    beforeDisconnect,
    "disconnect-before-commit",
  );
  await Bun.sleep(160);
  const beforeDisconnectObservation = await request(
    "GET",
    `/__s2/abort-observation?request_id=${encodeURIComponent(beforeDisconnectObservationId)}`,
    "disconnect-before-commit-observation",
  );
  assertEqual(
    beforeDisconnectObservation.status,
    200,
    "S2_DISCONNECT_BEFORE_COMMIT_NOT_ACCEPTED_BY_WORKER",
  );
  assertEqual(
    stringAt(beforeDisconnectObservation.body, "request_id"),
    beforeDisconnectObservationId,
    "S2_DISCONNECT_BEFORE_COMMIT_OBSERVATION_MISMATCH",
  );
  assertEqual(
    booleanAt(beforeDisconnectObservation.body, "accepted_before_commit"),
    true,
    "S2_DISCONNECT_BEFORE_COMMIT_ACCEPTANCE_INVALID",
  );
  assertEqual(
    booleanAt(beforeDisconnectObservation.body, "transaction_entered"),
    false,
    "S2_DISCONNECT_BEFORE_COMMIT_ENTERED_TRANSACTION",
  );
  const stateAfterBeforeDisconnect = await state(PRIMARY_PROBLEM, "disconnect-before-commit-state");
  assertEqual(stateAfterBeforeDisconnect.cursor, 13, "S2_DISCONNECT_BEFORE_COMMIT_ADVANCED_CURSOR");
  const retriedBeforeDisconnect = await write(writeBody(14), "disconnect-before-commit-retry");
  assertEqual(
    retriedBeforeDisconnect.idempotent,
    false,
    "S2_DISCONNECT_BEFORE_COMMIT_RETRY_INVALID",
  );
  writes.push(selectedSettledWrite(retriedBeforeDisconnect));

  const afterDisconnect = { ...writeBody(15), s2_post_commit_delay_ms: 125 };
  await expectTransportAbort(afterDisconnect, "disconnect-after-commit");
  await Bun.sleep(160);
  const retriedAfterDisconnect = await write(writeBody(15), "disconnect-after-commit-retry");
  assertEqual(retriedAfterDisconnect.idempotent, true, "S2_DISCONNECT_AFTER_COMMIT_RETRY_INVALID");

  const contention = await Promise.all(
    Array.from({ length: 16 }, (_, offset) => write(writeBody(offset + 16), "lock-contention")),
  );
  const contentionSeq = contention.map((entry) => entry.seq).sort((left, right) => left - right);
  assertEqual(
    contentionSeq.join(","),
    "16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31",
    "S2_LOCK_CONTENTION_SEQUENCE_INVALID",
  );
  writes.push(...contention.map(selectedSettledWrite));

  const durableOutboxState = await state(PRIMARY_PROBLEM, "outbox-before-worker-restart");
  assertEqual(durableOutboxState.cursor, 31, "S2_OUTBOX_CURSOR_INVALID");
  assertEqual(durableOutboxState.counts.outbox, 31, "S2_OUTBOX_PENDING_INVALID");
  assertEqual(durableOutboxState.counts.integrity_checkpoints, 31, "S2_CHECKPOINT_COUNT_INVALID");
  assertEqual(durableOutboxState.counts.event_chain_v2, 31, "S2_EVENT_CHAIN_V2_COUNT_INVALID");
  assertEqual(
    durableOutboxState.counts.checkpoint_chain_v2,
    31,
    "S2_CHECKPOINT_CHAIN_V2_COUNT_INVALID",
  );

  const readStorm = await Promise.all(
    Array.from({ length: 64 }, () =>
      request("GET", `/__s2/cursor?problem_id=${PRIMARY_PROBLEM}`, "local-read-storm"),
    ),
  );
  for (const read of readStorm) {
    assertEqual(read.status, 200, "S2_READ_STORM_STATUS_INVALID");
    assertEqual(safeNonnegativeIntegerAt(read.body, "cursor"), 31, "S2_READ_STORM_CURSOR_INVALID");
  }

  await seed(LARGE_PROBLEM, "seed-large-replay-corpus");
  for (let index = 1; index <= 201; index += 1) {
    const large = await write(
      writeBody(index, LARGE_PROBLEM, `Large replay corpus claim ${index}.`),
      "large-paginated-replay-corpus",
    );
    writes.push(selectedSettledWrite(large));
  }
  await assertReplay(LARGE_PROBLEM, 201, "large-paginated-full-replay");
  await legacyBoundedBackfill();
  await ordinaryWritesPastTheLimit();
  await mixedDigestLogIsNotComplete();
  await probePlanUsesPartialIndex();
  await preflightCostDoesNotGrowWithHistory();
  await exerciseOutboxDrainer();
  const costReceipt = writeS2CostMeasurementReceipt(
    writes,
    {
      run_id: requiredEnvironment("S2_RUN_ID"),
      revision: requiredEnvironment("S2_GIT_HEAD"),
      dirty_state: requiredDirtyState(),
      source_digest: requiredEnvironment("S2_SOURCE_DIGEST"),
    },
    {
      root: requiredEnvironment("S2_COST_RECEIPT_ROOT"),
      receiptPath: requiredEnvironment("S2_COST_RECEIPT_PATH"),
    },
  );

  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: "canonical-write-cursor-fts-replay-fault-contention",
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: 0,
    post_cursor: 201,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    checkpoint_mode: "unsigned-v0",
    metric_scope: costReceipt.receipt.metric_scope,
    write_receipt_count: costReceipt.receipt.write_receipt_count,
    successful_batch_metric_scope: costReceipt.receipt.successful_batch_metric_scope,
    failed_retry_batch_metrics: costReceipt.receipt.failed_retry_batch_metrics,
    write_claim_wall_scope: costReceipt.receipt.write_claim_wall_scope,
    p95_write_phase_ms: costReceipt.receipt.p95_write_phase_ms,
    sum_successful_batch_rows_read: costReceipt.receipt.sum_successful_batch_rows_read,
    sum_successful_batch_rows_written: costReceipt.receipt.sum_successful_batch_rows_written,
    sum_preflight_rows_read: costReceipt.receipt.sum_preflight_rows_read,
    sum_preflight_rows_written: costReceipt.receipt.sum_preflight_rows_written,
    p95_preflight_wall_ms: costReceipt.receipt.p95_preflight_wall_ms,
    sum_preflight_statements: costReceipt.receipt.sum_preflight_statements,
    p95_write_claim_wall_ms: costReceipt.receipt.p95_write_claim_wall_ms,
    lock_wait_ms: null,
    sum_retry_count: costReceipt.receipt.sum_retry_count,
    assertion_diff: null,
    total_harness_request_count: requestCount,
    cost_receipt: {
      path: costReceipt.artifact.relativePath,
      artifact_digest: costReceipt.artifact.digest,
      bytes: costReceipt.artifact.bytes,
    },
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

async function restartVerify(): Promise<void> {
  const primary = await state(PRIMARY_PROBLEM, "outbox-worker-restart-state");
  assertEqual(primary.cursor, 31, "S2_RESTART_CURSOR_INVALID");
  assertEqual(primary.counts.outbox, 31, "S2_RESTART_OUTBOX_INVALID");
  assertEqual(primary.counts.integrity_checkpoints, 31, "S2_RESTART_CHECKPOINT_INVALID");
  assertEqual(primary.counts.event_chain_v2, 31, "S2_RESTART_EVENT_CHAIN_V2_INVALID");
  assertEqual(
    primary.counts.checkpoint_chain_v2,
    31,
    "S2_RESTART_CHECKPOINT_CHAIN_V2_INVALID",
  );
  await assertReplay(PRIMARY_PROBLEM, 31, "outbox-worker-restart-replay");
  await assertReplay(LARGE_PROBLEM, 201, "large-replay-after-worker-restart");
  const recoveredOutbox = await waitForOutbox(
    "outbox-kill-restart-recovery",
    (status) =>
      status.quarantined === 1 &&
      status.pending === 0 &&
      status.last_phase === "quarantined" &&
      status.last_quarantine_code === "OUTBOX_PAYLOAD_INVALID",
  );
  assertEqual(recoveredOutbox.max_active, 1, "S2_OUTBOX_RESTART_OWNERSHIP_VIOLATION");
  assertEqual(recoveredOutbox.active, 0, "S2_OUTBOX_RESTART_ACTIVE_OWNER_LEAKED");
  assertEqual(recoveredOutbox.delivery_attempts >= 2, true, "S2_OUTBOX_RESTART_NOT_AT_LEAST_ONCE");
  assertEqual(
    recoveredOutbox.last_quarantine_code,
    "OUTBOX_PAYLOAD_INVALID",
    "S2_OUTBOX_QUARANTINE_DIAGNOSTIC_INVALID",
  );
  const outboxProblem = await state(OUTBOX_PROBLEM, "outbox-restart-visible-state");
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "event_chain_v2",
    "outbox",
    "integrity_checkpoints",
    "checkpoint_chain_v2",
  ] as const) {
    assertEqual(outboxProblem.counts[table], 7, "S2_OUTBOX_RESTART_DUPLICATED_VISIBLE_ROW");
  }
  await assertReplay(OUTBOX_PROBLEM, 7, "outbox-restart-visible-replay");
  // Last in the phase on purpose: this writes a claim, and a new outbox row would otherwise
  // perturb the recovery counters the assertions above pin exactly.
  await legacyBoundedBackfillAfterRestart();
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: "outbox-crash-restart-at-least-once-without-visible-duplicates",
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: 5,
    post_cursor: 5,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: primary.checkpoint_digest,
    checkpoint_mode: primary.checkpoint_mode,
    ...outboxAgeEvidence(recoveredOutbox),
    ...receiptMetrics(),
    lock_wait_ms: null,
    retry_count: recoveredOutbox.delivery_attempts,
    assertion_diff: null,
    total_harness_request_count: requestCount,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

// ── mounted-production promotion scenarios (6js.5) ──────────────────────────
//
// These drive the real `createApp` session path against this run's actual local
// D1 and KRATER_OUTBOX Durable Object, on the same origin the harness routes
// answer on: the worker delegates every non-`/__s2/` path to the mounted
// production app, so one process serves both the `/__s2/*` observers (harness
// token) and `/v1/*` promotions (a seeded Fellow bearer). The bearer is minted
// by `/__s2/seed-promotable`, consumed straight into the header of the mounted
// request, and never written to argv, exported env, a log line, or a retained
// receipt -- `request`'s diagnostics only ever read typed body fields.
// The full per-problem successful-write census: `/__s2/state` counts exactly
// these ten tables (inspectProblem in krater.ts), and a committed promotion writes
// one row into every one of them. Asserting the whole set -- not the
// claims/projections/events/outbox subset the outbox scenarios elsewhere use --
// is what makes the mounted no-lost/no-phantom claim exact rather than partial.
const MOUNTED_TABLES = [
  "claims",
  "claim_projections",
  "events",
  "event_chain_v2",
  "event_content",
  "public_claim_fts",
  "idempotency",
  "outbox",
  "integrity_checkpoints",
  "checkpoint_chain_v2",
] as const;

// A schema-valid WorkshopObjectId (W- + 26 base62 chars) that this fixture does
// not explicitly create, so a promote referencing it reaches the router's
// owned-object lookup and is refused there -- not rejected earlier by contract
// validation. All-zero is schema-valid but not mathematically impossible from a
// random mint, so the no-nudge scenario also asserts it differs from every
// workshop id the session actually minted before using it. Its validity is
// pinned against the shared schema at module load.
const MOUNTED_ABSENT_WORKSHOP_ID = `W-${"0".repeat(26)}`;
if (!WorkshopObjectIdSchema.safeParse(MOUNTED_ABSENT_WORKSHOP_ID).success) {
  fail("S2_MOUNTED_ABSENT_WORKSHOP_ID_INVALID");
}

/**
 * The Fellow name for a mounted problem. `enrollment_fellows.name` is COLLATE
 * NOCASE UNIQUE, so each of the five mounted problems needs its own name or the
 * second seed answers NAME_TAKEN. Derive it from the already-distinct problem id,
 * lowercased into FellowNameSchema's `^[a-z][a-z0-9-]{2,31}$` shape.
 */
function mountedFellowName(problemId: string): string {
  const name = `s2-${problemId.replace(/^P-/, "").toLowerCase()}`;
  if (!FellowNameSchema.safeParse(name).success) fail("S2_MOUNTED_FELLOW_NAME_INVALID");
  return name;
}

// Causal uniqueness proof for the five mounted Fellow names. If a future rename
// made two collide under NOCASE, the second seed would hit the DB's UNIQUE(name)
// mid-run; checking distinctness here at load fails fast and locally instead.
{
  const mountedNames = MOUNTED_PROBLEMS.map((problemId) =>
    mountedFellowName(problemId).toLowerCase(),
  );
  if (new Set(mountedNames).size !== mountedNames.length) {
    fail("S2_MOUNTED_FELLOW_NAMES_NOT_UNIQUE");
  }
}

/**
 * Mint a Fellow bearer for `problemId` through the local-only seed seam, which
 * runs the production EnrollmentService issuance (mint -> claim -> approve ->
 * poll) so the credential authenticates against the real enrollment graph. The
 * seed envelope is validated to exactly its three own keys, with the bearer
 * itself parsed by the shared FellowTokenSchema. The bearer is returned in
 * memory only; callers must not emit it.
 */
async function seedPromotable(problemId: string, scenario: string): Promise<string> {
  const seeded = await request("POST", "/__s2/seed-promotable", scenario, {
    problem_id: problemId,
    created_at: CREATED_AT,
    name: mountedFellowName(problemId),
  });
  assertEqual(seeded.status, 201, "S2_MOUNTED_SEED_FAILED");
  assertEqual(
    seeded.contentType,
    "application/json; charset=utf-8",
    "S2_MOUNTED_SEED_CONTENT_TYPE",
  );
  // Exact own keys: status, problem_id, bearer -- nothing else. A widened
  // envelope (an extra reflected field) is a refusal, not a warning.
  assertEqual(
    Object.keys(seeded.body).sort().join(","),
    "bearer,problem_id,status",
    "S2_MOUNTED_SEED_ENVELOPE_SHAPE_INVALID",
  );
  assertEqual(
    stringAt(seeded.body, "status"),
    "seeded-promotable",
    "S2_MOUNTED_SEED_STATUS_INVALID",
  );
  assertEqual(stringAt(seeded.body, "problem_id"), problemId, "S2_MOUNTED_SEED_PROBLEM_INVALID");
  const parsedBearer = FellowTokenSchema.safeParse(stringAt(seeded.body, "bearer"));
  if (!parsedBearer.success) fail("S2_MOUNTED_SEED_BEARER_INVALID");
  return parsedBearer.data ?? fail("S2_MOUNTED_SEED_BEARER_INVALID");
}

/** Header set for a mounted production request: the bearer never leaves memory. */
function mountedHeaders(
  bearer: string,
  idempotencyKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${bearer}`, "idempotency-key": idempotencyKey, ...extra };
}

async function mountedOpen(bearer: string, problemId: string, prefix: string): Promise<string> {
  const opened = await request(
    "POST",
    "/v1/sessions",
    `${prefix}-open`,
    { problem_id: problemId, intent: "prove" },
    5_000,
    mountedHeaders(bearer, `${prefix}-open`),
  );
  assertEqual(opened.status, 201, "S2_MOUNTED_SESSION_OPEN_FAILED");
  // Hono's c.json() (the session router's success path) emits exactly
  // `application/json` with no charset -- distinct from the harness seed helper's
  // charset variant; pin the exact value rather than a guessed common one.
  assertEqual(opened.contentType, "application/json", "S2_MOUNTED_SESSION_OPEN_CONTENT_TYPE");
  // Parse the WHOLE body with the shared strict session-open contract, not a
  // sampled field: an extra or malformed field is a contract failure here.
  const parsed = SessionOpenResponseSchema.safeParse(opened.body);
  if (!parsed.success) fail("S2_MOUNTED_SESSION_OPEN_SHAPE_INVALID");
  const openedSession = parsed.data ?? fail("S2_MOUNTED_SESSION_OPEN_SHAPE_INVALID");
  assertEqual(openedSession.problem_id, problemId, "S2_MOUNTED_SESSION_OPEN_PROBLEM_INVALID");
  return openedSession.session_id;
}

async function mountedWorkshop(
  bearer: string,
  sessionId: string,
  prefix: string,
  title: string,
): Promise<string> {
  const pushed = await request(
    "POST",
    `/v1/sessions/${sessionId}/workshop`,
    `${prefix}-workshop`,
    { type: "draft", title, body_md: `${title} prepares one durable promotion.`, relates_to: [] },
    5_000,
    mountedHeaders(bearer, `${prefix}-workshop`),
  );
  assertEqual(pushed.status, 201, "S2_MOUNTED_WORKSHOP_PUSH_FAILED");
  assertEqual(pushed.contentType, "application/json", "S2_MOUNTED_WORKSHOP_PUSH_CONTENT_TYPE");
  // The whole body must satisfy the shared strict schema; workshop_seq is a
  // positive int by that schema (a session's second push is seq 2, so the exact
  // value is not pinned here).
  const parsed = WorkshopPushResponseSchema.safeParse(pushed.body);
  if (!parsed.success) fail("S2_MOUNTED_WORKSHOP_PUSH_SHAPE_INVALID");
  return (parsed.data ?? fail("S2_MOUNTED_WORKSHOP_PUSH_SHAPE_INVALID")).workshop_id;
}

async function mountedOpenAndWorkshop(
  bearer: string,
  problemId: string,
  prefix: string,
): Promise<{ sessionId: string; workshopId: string }> {
  const sessionId = await mountedOpen(bearer, problemId, prefix);
  const workshopId = await mountedWorkshop(bearer, sessionId, prefix, `${prefix} draft`);
  return { sessionId, workshopId };
}

/** One mounted promote. Returns the raw result so refusals stay inspectable. */
async function mountedPromote(
  bearer: string,
  sessionId: string,
  idempotencyKey: string,
  workshopId: string,
  statement: string,
  scenario: string,
  extra: Record<string, string> = {},
): Promise<RequestResult> {
  return request(
    "POST",
    `/v1/sessions/${sessionId}/promote`,
    scenario,
    {
      workshop_id: workshopId,
      kind: "conjecture",
      statement,
      falsifier: "The durable row and the delivered outbox effect disagree.",
      relates_to: [],
    },
    5_000,
    mountedHeaders(bearer, idempotencyKey, extra),
  );
}

/** Parse a committed promote's WHOLE body with the shared strict contract. */
function parseMountedPromote(result: RequestResult, code: string): PromoteResponse {
  assertEqual(result.status, 201, code);
  // Hono c.json() success media type: exactly `application/json`, no charset.
  assertEqual(result.contentType, "application/json", `${code}_CONTENT_TYPE`);
  const parsed = PromoteResponseSchema.safeParse(result.body);
  if (!parsed.success) fail(`${code}_SHAPE`);
  return parsed.data ?? fail(`${code}_SHAPE`);
}

/**
 * Assert a refused mounted promote: the exact HTTP status, the exact problem
 * `code`, an application/problem+json body, and no reflection of the caller's
 * bearer. The refusal problem body is NOT parsed by a shared closed schema on
 * purpose: the session router still emits these session codes
 * (WORKSHOP_OBJECT_NOT_FOUND, DUPLICATE_CLAIM) through the generic problem()
 * helper, and cataloguing them into the closed schema is owned by bead
 * asimposiumorg-but.1. Until but.1 lands, the exact status+code+media-type is the
 * strongest contract-shaped assertion available here.
 */
function assertMountedRefusal(
  result: RequestResult,
  status: number,
  code: string,
  bearer: string,
  diagnostic: string,
): void {
  assertEqual(result.status, status, `${diagnostic}_STATUS`);
  assertEqual(
    result.contentType,
    "application/problem+json; charset=utf-8",
    `${diagnostic}_CONTENT_TYPE`,
  );
  assertEqual(stringAt(result.body, "code"), code, `${diagnostic}_CODE`);
  // Non-reflection: a refusal must never echo the Fellow bearer back.
  assertEqual(JSON.stringify(result.body).includes(bearer), false, `${diagnostic}_REFLECTS_BEARER`);
}

function assertMountedCensus(census: S2StateResult, code: string): void {
  for (const table of MOUNTED_TABLES) assertEqual(census.counts[table], 1, code);
}

/**
 * The exact, whole-of-S2OutboxStatus DO tuple in a fixed canonical field order.
 * A refused promote that wrongly touched the drainer could move ownership, the
 * alarm, a backoff/quarantine field, or an age field without changing
 * delivered/pending, so the no-nudge scenario compares every field, not a
 * subset. After a settled baseline (pending 0, alarm cleared) all of these stay
 * exact across a pair of refusals.
 */
function outboxTuple(status: S2OutboxStatus): string {
  return JSON.stringify({
    active: status.active,
    pending: status.pending,
    alarm_at: status.alarm_at,
    owner_acquisitions: status.owner_acquisitions,
    max_active: status.max_active,
    recovered_ownerships: status.recovered_ownerships,
    delivery_attempts: status.delivery_attempts,
    delivered: status.delivered,
    quarantined: status.quarantined,
    failures: status.failures,
    last_backoff_ms: status.last_backoff_ms,
    last_quarantine_code: status.last_quarantine_code,
    last_phase: status.last_phase,
    oldest_pending_age_ms: status.oldest_pending_age_ms,
    oldest_pending_age_status: status.oldest_pending_age_status,
    oldest_pending_age_alert: status.oldest_pending_age_alert,
    oldest_pending_age_alert_threshold_ms: status.oldest_pending_age_alert_threshold_ms,
  });
}

/** Canonical promote receipt for cross-response equality (fixed key order). */
function canonicalPromote(receipt: {
  claim_id: string;
  problem_id: string;
  seq: number;
  queue_position: number;
}): string {
  return JSON.stringify({
    claim_id: receipt.claim_id,
    problem_id: receipt.problem_id,
    seq: receipt.seq,
    queue_position: receipt.queue_position,
  });
}

/**
 * (a) Commit -> nudge -> effect -> ack. A mounted promotion commits its durable
 * D1 row, the propagated post-commit context wakes the real DO, and the DO
 * drains the row to `delivered`. Measured as a delta from a baseline captured
 * immediately before, so the global DO counters from earlier phases do not
 * matter.
 */
async function mountedHappyPathPromotion(): Promise<void> {
  const bearer = await seedPromotable(MOUNTED_PROBLEM, "mounted-happy-seed");
  const base = await outboxStatus("mounted-happy-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS);
  const prepared = await mountedOpenAndWorkshop(bearer, MOUNTED_PROBLEM, "mounted-happy");
  const promoted = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-happy-promote",
    prepared.workshopId,
    "A mounted promotion commits then wakes the drainer exactly once.",
    "mounted-happy-commit",
  );
  const claim = parseMountedPromote(promoted, "S2_MOUNTED_PROMOTE_NOT_COMMITTED");
  assertEqual(claim.claim_id, "C-1", "S2_MOUNTED_PROMOTE_CLAIM_ID_INVALID");
  assertEqual(claim.seq, 1, "S2_MOUNTED_PROMOTE_SEQ_INVALID");
  assertEqual(claim.problem_id, MOUNTED_PROBLEM, "S2_MOUNTED_PROMOTE_PROBLEM_INVALID");
  const delivered = await waitForOutbox(
    "mounted-happy-delivered",
    (status) =>
      status.delivered === base.delivered + 1 &&
      status.pending === base.pending &&
      status.last_phase === "delivered",
  );
  // Exactly one attempt delivered exactly one row: a retry-tolerant `>=` would
  // not prove single-effect. owner_acquisitions is intentionally not pinned --
  // a duplicate wake may legitimately add an empty ownership scan.
  assertEqual(
    delivered.delivery_attempts,
    base.delivery_attempts + 1,
    "S2_MOUNTED_HAPPY_NOT_EXACTLY_ONE_ATTEMPT",
  );
  assertEqual(delivered.max_active, 1, "S2_MOUNTED_HAPPY_OWNERSHIP_INVALID");
  assertEqual(delivered.active, 0, "S2_MOUNTED_HAPPY_ACTIVE_OWNER_LEAKED");
  assertMountedCensus(
    await state(MOUNTED_PROBLEM, "mounted-happy-census"),
    "S2_MOUNTED_HAPPY_CENSUS_INVALID",
  );
}

/**
 * (b) Non-vacuous no-nudge. Scenario (a) proves the detector fires for a real
 * promote; here a real commit on this problem establishes a live baseline, then
 * two refusals -- a 404 for a workshop id this session did not create, and a 409
 * P11 near-duplicate -- each reach no commit and so schedule no nudge and enqueue
 * no row. The whole DO tuple, not just delivered/pending, is unchanged
 * afterwards, so a refusal that touched ownership or the alarm without moving
 * those two counters is still caught.
 */
async function mountedRefusedPromotionsWakeNothing(): Promise<void> {
  const bearer = await seedPromotable(MOUNTED_NO_NUDGE_PROBLEM, "mounted-no-nudge-seed");
  const prepared = await mountedOpenAndWorkshop(
    bearer,
    MOUNTED_NO_NUDGE_PROBLEM,
    "mounted-no-nudge",
  );
  const statement = "A refused mounted promote wakes the drainer zero times.";
  const committed = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-no-nudge-commit-key",
    prepared.workshopId,
    statement,
    "mounted-no-nudge-commit",
  );
  parseMountedPromote(committed, "S2_MOUNTED_NO_NUDGE_SETUP_NOT_COMMITTED");
  await waitForOutbox(
    "mounted-no-nudge-settle",
    (status) => status.pending === 0 && status.last_phase === "delivered",
  );
  // A settled snapshot (post-delivery, alarm cleared) is the exact tuple the two
  // refusals must not perturb.
  const baseTuple = outboxTuple(
    await outboxStatus("mounted-no-nudge-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS),
  );
  const secondWorkshop = await mountedWorkshop(
    bearer,
    prepared.sessionId,
    "mounted-no-nudge-second",
    "second draft",
  );
  // All-zero is schema-valid but not impossible from a random mint: prove the
  // absent id is not one this session actually created before relying on the 404.
  assertEqual(
    MOUNTED_ABSENT_WORKSHOP_ID !== prepared.workshopId &&
      MOUNTED_ABSENT_WORKSHOP_ID !== secondWorkshop,
    true,
    "S2_MOUNTED_ABSENT_WORKSHOP_ID_COLLIDED",
  );
  const missing = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-no-nudge-missing-key",
    MOUNTED_ABSENT_WORKSHOP_ID,
    "This mounted promote references no owned workshop object.",
    "mounted-no-nudge-missing",
  );
  // WORKSHOP_OBJECT_NOT_FOUND and DUPLICATE_CLAIM are still emitted through the
  // router's generic problem() helper; cataloguing them into the closed schema is
  // bead asimposiumorg-but.1. Exact status + code + problem+json is the strongest
  // contract-shaped assertion here until but.1 lands.
  assertMountedRefusal(
    missing,
    404,
    "WORKSHOP_OBJECT_NOT_FOUND",
    bearer,
    "S2_MOUNTED_NO_NUDGE_MISSING",
  );
  const duplicate = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-no-nudge-dup-key",
    secondWorkshop,
    statement,
    "mounted-no-nudge-duplicate",
  );
  assertMountedRefusal(duplicate, 409, "DUPLICATE_CLAIM", bearer, "S2_MOUNTED_NO_NUDGE_DUPLICATE");
  assertEqual(
    outboxTuple(await outboxStatus("mounted-no-nudge-after", S2_OUTBOX_STATUS_TIMEOUT_MS)),
    baseTuple,
    "S2_MOUNTED_NO_NUDGE_DO_TUPLE_CHANGED",
  );
  assertMountedCensus(
    await state(MOUNTED_NO_NUDGE_PROBLEM, "mounted-no-nudge-census"),
    "S2_MOUNTED_NO_NUDGE_CENSUS_INVALID",
  );
}

/**
 * (d) Duplicate/race CAS exactly-once, at BOTH the producer and the nudge. Two
 * overlapping identical promotes race: exactly one wins the atomic replay
 * election and commits (201, exactly `application/json`), the loser's Krater
 * batch aborts before the post-commit nudge and it returns 200 with the winner's
 * bytes. That 200 is served by one of two real source paths depending on which
 * side of the winner's replay-row commit the loser's read falls -- the
 * top-of-handler exact-response replay (`application/json; charset=utf-8`) or the
 * post-commit c.json path (`application/json`) -- so its media type is asserted
 * against exactly those two values. Both bodies parse under the shared contract
 * and must be canonically identical.
 *
 * The producers commit through the injected binding-failure seam, so the row is
 * durable-but-pending with no delivery yet. Then several real DO nudges and the
 * scheduled reconcile are fired CONCURRENTLY: this is the duplicate-nudge race,
 * and the DO's single-owner CAS collapses them to exactly one delivery attempt
 * and one effect. Every census table stays at one.
 */
async function mountedDuplicateRaceIsExactlyOnce(): Promise<void> {
  const bearer = await seedPromotable(MOUNTED_CAS_PROBLEM, "mounted-cas-seed");
  const base = await outboxStatus("mounted-cas-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS);
  const prepared = await mountedOpenAndWorkshop(bearer, MOUNTED_CAS_PROBLEM, "mounted-cas");
  const key = "mounted-cas-promote-key";
  const statement = "Concurrent identical mounted promotes elect exactly one envelope.";
  const bindingFail = { "x-s2-nudge-binding-fail": "1" };
  const [first, second] = await Promise.all([
    mountedPromote(
      bearer,
      prepared.sessionId,
      key,
      prepared.workshopId,
      statement,
      "mounted-cas-a",
      bindingFail,
    ),
    mountedPromote(
      bearer,
      prepared.sessionId,
      key,
      prepared.workshopId,
      statement,
      "mounted-cas-b",
      bindingFail,
    ),
  ]);
  // Exactly one commit and one durable replay, in either arrival order. Two
  // commits would show as 201,201 here.
  assertEqual(
    [first.status, second.status].sort((left, right) => left - right).join(","),
    "200,201",
    "S2_MOUNTED_CAS_RACE_STATUS_INVALID",
  );
  const committed = first.status === 201 ? first : second;
  const replayed = first.status === 201 ? second : first;
  const committedClaim = parseMountedPromote(committed, "S2_MOUNTED_CAS_COMMIT_NOT_201");
  assertEqual(committedClaim.claim_id, "C-1", "S2_MOUNTED_CAS_CLAIM_ID_INVALID");
  assertEqual(committedClaim.seq, 1, "S2_MOUNTED_CAS_SEQ_INVALID");
  assertEqual(
    ["application/json", "application/json; charset=utf-8"].includes(replayed.contentType),
    true,
    "S2_MOUNTED_CAS_REPLAY_CONTENT_TYPE",
  );
  const parsedReplay = PromoteResponseSchema.safeParse(replayed.body);
  if (!parsedReplay.success) fail("S2_MOUNTED_CAS_REPLAY_SHAPE");
  const replayClaim = parsedReplay.data ?? fail("S2_MOUNTED_CAS_REPLAY_SHAPE");
  assertEqual(
    canonicalPromote(committedClaim),
    canonicalPromote(replayClaim),
    "S2_MOUNTED_CAS_RECEIPTS_DIVERGE",
  );
  // The injected binding failure left the single winning row committed but
  // undelivered: one producer, one pending row, no delivery.
  const stranded = await outboxStatus("mounted-cas-stranded", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(stranded.pending, base.pending + 1, "S2_MOUNTED_CAS_NOT_PENDING");
  assertEqual(stranded.delivered, base.delivered, "S2_MOUNTED_CAS_PHANTOM_DELIVERY");
  // The duplicate-nudge race: several real DO wakes and the scheduled reconcile,
  // all concurrent. The reconcile leg throws on a non-200; the nudge legs are
  // each asserted 202. The single-owner CAS must collapse them to one delivery.
  const [wakeA, wakeB, wakeC] = await Promise.all([
    request("POST", "/__s2/outbox/nudge", "mounted-cas-wake-a", { fault_mode: "none" }),
    request("POST", "/__s2/outbox/nudge", "mounted-cas-wake-b", { fault_mode: "none" }),
    request("POST", "/__s2/outbox/nudge", "mounted-cas-wake-c", { fault_mode: "none" }),
    triggerScheduledOutboxReconcile("mounted-cas-reconcile"),
  ]);
  for (const wake of [wakeA, wakeB, wakeC]) {
    assertEqual(wake.status, 202, "S2_MOUNTED_CAS_WAKE_FAILED");
  }
  const delivered = await waitForOutbox(
    "mounted-cas-delivered",
    (status) =>
      status.delivered === base.delivered + 1 &&
      status.pending === base.pending &&
      status.last_phase === "delivered",
  );
  // Exactly one delivery attempt despite four concurrent wakes: the collapse is
  // the CAS proof. owner_acquisitions is not pinned -- each wake may add an empty
  // ownership scan.
  assertEqual(
    delivered.delivery_attempts,
    base.delivery_attempts + 1,
    "S2_MOUNTED_CAS_NOT_EXACTLY_ONE_ATTEMPT",
  );
  assertEqual(delivered.max_active, 1, "S2_MOUNTED_CAS_OWNERSHIP_INVALID");
  assertEqual(delivered.active, 0, "S2_MOUNTED_CAS_ACTIVE_OWNER_LEAKED");
  assertMountedCensus(
    await state(MOUNTED_CAS_PROBLEM, "mounted-cas-census"),
    "S2_MOUNTED_CAS_DUPLICATED_ROW",
  );
}

/**
 * (c) Injected binding failure, then real-DO recovery. The `x-s2-nudge-binding-fail`
 * seam runs the mounted app for this one request with a KRATER_OUTBOX handle that
 * throws on construction. This is an INJECTED BINDING FAILURE, not a real-DO nudge
 * failure: the commit still writes its durable D1 row, but the detached
 * post-commit nudge cannot reach the DO and is swallowed, leaving the row
 * committed-and-pending with no delivery. The ordinary manual reconcile then
 * drives the real DO on the real binding, which drains the row exactly once.
 */
async function mountedInjectedBindingFailureRecovers(): Promise<void> {
  const bearer = await seedPromotable(MOUNTED_BINDING_FAIL_PROBLEM, "mounted-binding-fail-seed");
  const base = await outboxStatus("mounted-binding-fail-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS);
  const prepared = await mountedOpenAndWorkshop(
    bearer,
    MOUNTED_BINDING_FAIL_PROBLEM,
    "mounted-binding-fail",
  );
  const committed = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-binding-fail-key",
    prepared.workshopId,
    "An injected binding failure leaves the promotion committed but unnudged.",
    "mounted-binding-fail-commit",
    { "x-s2-nudge-binding-fail": "1" },
  );
  const claim = parseMountedPromote(committed, "S2_MOUNTED_BINDING_FAIL_NOT_COMMITTED");
  assertEqual(claim.claim_id, "C-1", "S2_MOUNTED_BINDING_FAIL_CLAIM_INVALID");
  const stranded = await outboxStatus("mounted-binding-fail-stranded", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(stranded.pending, base.pending + 1, "S2_MOUNTED_BINDING_FAIL_NOT_PENDING");
  assertEqual(stranded.delivered, base.delivered, "S2_MOUNTED_BINDING_FAIL_PHANTOM_DELIVERY");
  await triggerScheduledOutboxReconcile("mounted-binding-fail-reconcile");
  const recovered = await waitForOutbox(
    "mounted-binding-fail-recovered",
    (status) =>
      status.delivered === base.delivered + 1 &&
      status.pending === base.pending &&
      status.last_phase === "delivered",
  );
  // Exactly one real delivery attempt: the injected-failure nudge never reached
  // the DO, so the reconcile's single drain is the only attempt on this row.
  assertEqual(
    recovered.delivery_attempts,
    base.delivery_attempts + 1,
    "S2_MOUNTED_BINDING_FAIL_NOT_EXACTLY_ONE_ATTEMPT",
  );
  assertEqual(recovered.max_active, 1, "S2_MOUNTED_BINDING_FAIL_OWNERSHIP_INVALID");
  assertEqual(recovered.active, 0, "S2_MOUNTED_BINDING_FAIL_ACTIVE_OWNER_LEAKED");
  assertMountedCensus(
    await state(MOUNTED_BINDING_FAIL_PROBLEM, "mounted-binding-fail-census"),
    "S2_MOUNTED_BINDING_FAIL_CENSUS_INVALID",
  );
}

/**
 * (e) setup, pre-restart. Commit through the injected binding-failure seam so the
 * promotion is durable in D1 but never delivered, leaving exactly one pending row
 * for the post-restart reconcile. The bearer is consumed entirely within this
 * pre-crash process and never persisted; it cannot and need not survive the
 * restart, because the durable D1 row and the real DO carry the proof across it.
 */
async function mountedCrashSetupLeavesOneDurablePending(): Promise<void> {
  const bearer = await seedPromotable(MOUNTED_CRASH_PROBLEM, "mounted-crash-seed");
  const base = await outboxStatus("mounted-crash-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS);
  const prepared = await mountedOpenAndWorkshop(bearer, MOUNTED_CRASH_PROBLEM, "mounted-crash");
  const committed = await mountedPromote(
    bearer,
    prepared.sessionId,
    "mounted-crash-key",
    prepared.workshopId,
    "A committed promotion must survive a worker restart and deliver exactly once.",
    "mounted-crash-commit",
    { "x-s2-nudge-binding-fail": "1" },
  );
  parseMountedPromote(committed, "S2_MOUNTED_CRASH_SETUP_NOT_COMMITTED");
  const stranded = await outboxStatus("mounted-crash-stranded", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(stranded.pending, base.pending + 1, "S2_MOUNTED_CRASH_SETUP_NOT_PENDING");
  assertEqual(stranded.delivered, base.delivered, "S2_MOUNTED_CRASH_SETUP_PHANTOM_DELIVERY");
  const census = await state(MOUNTED_CRASH_PROBLEM, "mounted-crash-setup-census");
  assertEqual(census.counts.outbox, 1, "S2_MOUNTED_CRASH_SETUP_OUTBOX_INVALID");
  assertEqual(census.counts.events, 1, "S2_MOUNTED_CRASH_SETUP_EVENT_INVALID");
  assertEqual(census.counts.event_chain_v2, 1, "S2_MOUNTED_CRASH_SETUP_EVENT_CHAIN_V2_INVALID");
  assertEqual(
    census.counts.checkpoint_chain_v2,
    1,
    "S2_MOUNTED_CRASH_SETUP_CHECKPOINT_CHAIN_V2_INVALID",
  );
}

/**
 * (e) verify, post-restart. The durable D1 row and its claim survived the
 * same-persist restart even though the bearer did not. A manual reconcile drives
 * the real DO -- idempotent if the restarted DO already recovered the row on its
 * own -- and the row is delivered exactly once: pending returns to zero and the
 * per-problem census never doubles (no lost, no phantom).
 */
async function mountedCrashRecoveryDeliversExactlyOnce(): Promise<void> {
  const survived = await state(MOUNTED_CRASH_PROBLEM, "mounted-crash-survived");
  assertEqual(survived.counts.outbox, 1, "S2_MOUNTED_CRASH_ROW_LOST");
  assertEqual(survived.counts.events, 1, "S2_MOUNTED_CRASH_EVENT_LOST");
  assertEqual(survived.counts.event_chain_v2, 1, "S2_MOUNTED_CRASH_EVENT_CHAIN_V2_LOST");
  assertEqual(
    survived.counts.checkpoint_chain_v2,
    1,
    "S2_MOUNTED_CRASH_CHECKPOINT_CHAIN_V2_LOST",
  );
  assertEqual(survived.counts.claims, 1, "S2_MOUNTED_CRASH_CLAIM_LOST");
  // The crash row was committed via the binding-failure seam, so the DO never
  // armed an alarm for it; on restart it does not self-deliver, and /status is
  // read-only. So a baseline captured here still shows the row pending, and the
  // reconcile below is the single delivery -- an exact +1, not a >=.
  const base = await outboxStatus("mounted-crash-recovery-baseline", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(base.pending >= 1, true, "S2_MOUNTED_CRASH_PENDING_NOT_DURABLE");
  await triggerScheduledOutboxReconcile("mounted-crash-reconcile");
  const recovered = await waitForOutbox(
    "mounted-crash-recovered",
    (status) =>
      status.delivered === base.delivered + 1 &&
      status.pending === base.pending - 1 &&
      status.last_phase === "delivered",
  );
  assertEqual(
    recovered.delivery_attempts,
    base.delivery_attempts + 1,
    "S2_MOUNTED_CRASH_NOT_EXACTLY_ONE_ATTEMPT",
  );
  assertEqual(recovered.max_active, 1, "S2_MOUNTED_CRASH_RESTART_OWNERSHIP_VIOLATION");
  assertEqual(recovered.active, 0, "S2_MOUNTED_CRASH_RESTART_ACTIVE_OWNER_LEAKED");
  assertMountedCensus(
    await state(MOUNTED_CRASH_PROBLEM, "mounted-crash-recovery-census"),
    "S2_MOUNTED_CRASH_DUPLICATED_ROW",
  );
}

/**
 * (f) Final census. The no-lost/no-phantom proof is the sum of five EXACT
 * per-problem D1 censuses -- each mounted problem committed exactly one claim,
 * with exactly one row in every one of the eight written tables and a projection
 * that replays to a single event -- combined with the EXACT per-scenario DO
 * deltas each scenario already asserted (delivered +1, delivery_attempts +1).
 * The DO counters are global and accumulate across earlier phases (restart-verify
 * even leaves one quarantined row), so this is deliberately NOT asserted as an
 * absolute global DO total; only the drained-and-owned invariants (nothing
 * pending, a single owner, no active leak) are asserted globally.
 */
async function mountedFinalCensus(): Promise<void> {
  for (const problemId of MOUNTED_PROBLEMS) {
    assertMountedCensus(
      await state(problemId, "mounted-final-census"),
      "S2_MOUNTED_FINAL_CENSUS_INVALID",
    );
    await assertReplay(problemId, 1, "mounted-final-replay");
  }
  const outbox = await outboxStatus("mounted-final-outbox", S2_OUTBOX_STATUS_TIMEOUT_MS);
  assertEqual(outbox.pending, 0, "S2_MOUNTED_FINAL_PENDING_NONZERO");
  assertEqual(outbox.max_active, 1, "S2_MOUNTED_FINAL_OWNERSHIP_INVALID");
  assertEqual(outbox.active, 0, "S2_MOUNTED_FINAL_ACTIVE_OWNER_LEAKED");
}

/**
 * The retained terminal record for a mounted phase. Because the cost manifest
 * intentionally carries no mounted keys, this record must itself hold the exact
 * measured DO summary it stands for -- the explicit `mounted_*` fields below --
 * plus the scenario count that ran. All values are nonsecret DO counters; no
 * ids, bearers, or replay keys are ever emitted.
 */
function emitMountedPass(
  scenario: string,
  observed: S2OutboxStatus,
  mountedScenarioCount: number,
): void {
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-do-mounted",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario,
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: null,
    post_cursor: null,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    checkpoint_mode: null,
    ...outboxAgeEvidence(observed),
    ...receiptMetrics(),
    mounted_scenario_count: mountedScenarioCount,
    mounted_pending: observed.pending,
    mounted_delivered: observed.delivered,
    mounted_delivery_attempts: observed.delivery_attempts,
    mounted_owner_acquisitions: observed.owner_acquisitions,
    mounted_recovered_ownerships: observed.recovered_ownerships,
    mounted_failures: observed.failures,
    mounted_quarantined: observed.quarantined,
    mounted_max_active: observed.max_active,
    mounted_active: observed.active,
    mounted_alarm_at: observed.alarm_at,
    mounted_alarm_armed: observed.alarm_at !== null,
    mounted_last_phase: observed.last_phase,
    lock_wait_ms: null,
    retry_count: observed.delivery_attempts,
    assertion_diff: null,
    total_harness_request_count: requestCount,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

/**
 * The pre-restart mounted phase: the commit->nudge->effect->ack path, the
 * non-vacuous no-nudge refusals, the CAS exactly-once race, the injected
 * binding-failure recovery, and the durable pending row the crash will strand.
 * The shell then restarts the worker against the same persistence directory.
 */
async function mountedOutbox(): Promise<void> {
  await mountedHappyPathPromotion();
  await mountedRefusedPromotionsWakeNothing();
  await mountedDuplicateRaceIsExactlyOnce();
  await mountedInjectedBindingFailureRecovers();
  await mountedCrashSetupLeavesOneDurablePending();
  // Four scenarios prove their claims here (a, b, d, c); the fifth (crash setup)
  // only strands a durable row for the post-restart phase to recover.
  emitMountedPass(
    "mounted-promotion-commit-nudge-effect-ack-no-nudge-cas-binding-fail",
    await outboxStatus("mounted-outbox-phase-status", S2_OUTBOX_STATUS_TIMEOUT_MS),
    5,
  );
}

/**
 * The post-restart mounted phase: the crash the pre-restart phase set up is
 * recovered exactly once against the real DO, and the final exact D1/outbox/DO
 * census proves no lost and no phantom.
 */
async function mountedOutboxRestartVerify(): Promise<void> {
  await mountedCrashRecoveryDeliversExactlyOnce();
  await mountedFinalCensus();
  // Two scenarios here: the crash recovery (e) and the final census (f).
  emitMountedPass(
    "mounted-promotion-crash-restart-reconcile-exactly-once-census",
    await outboxStatus("mounted-restart-phase-status", S2_OUTBOX_STATUS_TIMEOUT_MS),
    2,
  );
}

async function main(): Promise<void> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  if (REVISION === undefined || !/^[0-9a-f]{40}$/.test(REVISION)) fail("S2_GIT_HEAD_INVALID");
  if (DIRTY_STATE !== "clean" && DIRTY_STATE !== "dirty") fail("S2_GIT_DIRTY_INVALID");
  if (SOURCE_DIGEST === undefined || !/^[0-9a-f]{64}$/.test(SOURCE_DIGEST)) {
    fail("S2_SOURCE_DIGEST_INVALID");
  }
  requireHarnessToken();
  if (phase === "exercise") return exercise();
  if (phase === "restart-verify") return restartVerify();
  if (phase === "mounted-outbox") return mountedOutbox();
  if (phase === "mounted-outbox-restart-verify") return mountedOutboxRestartVerify();
  if (phase === "upgrade-existing") return upgradeExisting();
  if (phase === "upgrade-indexed") return upgradeIndexed();
  if (phase === "upgrade-empty") return upgradeEmpty();
  if (phase === "upgrade-journal-existing") {
    await upgradeExisting("migration-journal");
    return upgradeIndexed("migration-journal");
  }
  if (phase === "upgrade-journal-empty") return upgradeEmpty("migration-journal");
  fail("S2_PHASE_INVALID");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") return fail(`${name}_INVALID`);
  return value;
}

function requiredDirtyState(): "clean" | "dirty" {
  if (DIRTY_STATE === "clean" || DIRTY_STATE === "dirty") return DIRTY_STATE;
  return fail("S2_GIT_DIRTY_INVALID");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    emit({
      tool: "bun",
      tool_version: Bun.version,
      package: "apps/wire",
      suite: "s2-krater-local-d1",
      revision: REVISION,
      dirty_state: DIRTY_STATE,
      source_digest: SOURCE_DIGEST,
      bindings: BINDINGS,
      scenario: phase,
      seed: SEED,
      scope: SCOPE,
      request_id: null,
      event_id: null,
      pre_cursor: null,
      post_cursor: null,
      payload_sha256: null,
      row_digest: null,
      build_digest: null,
      checkpoint_digest: null,
      checkpoint_mode: null,
      ...receiptMetrics(),
      lock_wait_ms: null,
      retry_count: null,
      assertion_diff: error instanceof Error ? error.message : "S2_UNEXPECTED_FAILURE",
      status: "fail",
      reproduce: "scripts/e2e-s2-krater.sh",
    });
    process.exitCode = 1;
  });
}
