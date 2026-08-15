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
  MAX_S2_COST_RECEIPT_BYTES,
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
} from "@asimposium/contracts";

const origin = process.env.S2_ORIGIN;
const phase = process.env.S2_PHASE ?? "exercise";
const harnessToken = process.env.S2_HARNESS_TOKEN;

const REVISION = process.env.S2_GIT_HEAD;
const DIRTY_STATE = process.env.S2_GIT_DIRTY;
const SOURCE_DIGEST = process.env.S2_SOURCE_DIGEST;
const SEED = "s2-local-chain-v1";
const SCOPE = S2_LOCAL_SCOPE;
const BINDINGS: S2CostMeasurementReceipt["bindings"] = {
  d1: "DB",
  durable_object: "KRATER_OUTBOX",
  r2: null,
};
const HARNESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SUCCESSFUL_BATCH_METRIC_SCOPE: typeof S2_SUCCESSFUL_BATCH_SCOPE = S2_SUCCESSFUL_BATCH_SCOPE;
const FAILED_RETRY_BATCH_METRICS: typeof S2_FAILED_RETRY_SCOPE = S2_FAILED_RETRY_SCOPE;
const WRITE_CLAIM_WALL_SCOPE: typeof S2_WRITE_CLAIM_SCOPE = S2_WRITE_CLAIM_SCOPE;
const CREATED_AT = "2026-08-14T00:00:00.000Z";
const PRIMARY_PROBLEM = "P-s2";
const SECONDARY_PROBLEM = "P-s2-b";
const LARGE_PROBLEM = "P-s2-large";
const OUTBOX_PROBLEM = "P-s2-outbox";
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

interface WriteResult {
  event_id: string;
  seq: number;
  idempotent: boolean;
  pre_cursor: number;
  post_cursor: number;
  payload_sha256: string;
  row_digest: string;
  build_digest: string;
  chain_digest: string;
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
    typeof write.payload_sha256 !== "string" ||
    typeof write.row_digest !== "string" ||
    typeof write.build_digest !== "string" ||
    typeof write.chain_digest !== "string" ||
    typeof write.checkpoint_digest !== "string" ||
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

interface StateResult {
  cursor: number;
  counts: Record<string, number>;
  chain_digest: string;
  checkpoint_digest: string | null;
  checkpoint_mode: "unsigned-v0";
}

interface RequestResult {
  status: number;
  body: Record<string, unknown>;
  elapsedMs: number;
  contentType: string;
  requestId: string;
}

interface OutboxStatus {
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
}

let requestCount = 0;

const emit = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

const fail = (code: string): never => {
  throw new Error(code);
};

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

function nullableNumberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return value === null || value === undefined ? null : numberAt(record, key);
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") fail("S2_RESPONSE_INVALID");
  return value as string;
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
    pre_cursor: body === undefined ? null : nullableNumberAt(body, "pre_cursor"),
    post_cursor: body === undefined ? null : nullableNumberAt(body, "post_cursor"),
    payload_sha256: body === undefined ? null : nullableStringAt(body, "payload_sha256"),
    row_digest: body === undefined ? null : nullableStringAt(body, "row_digest"),
    build_digest: body === undefined ? null : nullableStringAt(body, "build_digest"),
    chain_digest: body === undefined ? null : nullableStringAt(body, "chain_digest"),
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
): Promise<RequestResult> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const currentRequestId = requestId();
  const eventId = requestEventId(body);
  const started = performance.now();
  try {
    const token = requireHarnessToken();
    const fetchResponse = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
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

function writeResult(body: Record<string, unknown>): WriteResult {
  return {
    event_id: stringAt(body, "event_id"),
    seq: numberAt(body, "seq"),
    idempotent: booleanAt(body, "idempotent"),
    pre_cursor: numberAt(body, "pre_cursor"),
    post_cursor: numberAt(body, "post_cursor"),
    payload_sha256: stringAt(body, "payload_sha256"),
    row_digest: stringAt(body, "row_digest"),
    build_digest: stringAt(body, "build_digest"),
    chain_digest: stringAt(body, "chain_digest"),
    checkpoint_digest: stringAt(body, "checkpoint_digest"),
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

function stateResult(body: Record<string, unknown>): StateResult {
  const counts = asRecord(body.counts);
  const typedCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("S2_RESPONSE_INVALID");
    typedCounts[key] = value as number;
  }
  return {
    cursor: numberAt(body, "cursor"),
    counts: typedCounts,
    chain_digest: stringAt(body, "chain_digest"),
    checkpoint_digest: body.checkpoint_digest === null ? null : stringAt(body, "checkpoint_digest"),
    checkpoint_mode: ((): "unsigned-v0" => {
      const mode = stringAt(body, "checkpoint_mode");
      if (mode !== "unsigned-v0") fail("S2_CHECKPOINT_MODE_INVALID");
      return "unsigned-v0";
    })(),
  };
}

function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code);
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

function canonicalState(state: StateResult): string {
  return JSON.stringify({
    chain_digest: state.chain_digest,
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

async function state(problemId: string, scenario: string): Promise<StateResult> {
  const response = await request("GET", `/__s2/state?problem_id=${problemId}`, scenario);
  assertEqual(response.status, 200, "S2_STATE_READ_FAILED");
  return stateResult(response.body);
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
  return writeResult(result.body);
}

function outboxStatusResult(body: Record<string, unknown>): OutboxStatus {
  return {
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
  };
}

async function outboxStatus(scenario: string): Promise<OutboxStatus> {
  const result = await request("GET", "/__s2/outbox/status", scenario);
  assertEqual(result.status, 200, "S2_OUTBOX_STATUS_FAILED");
  return outboxStatusResult(result.body);
}

async function waitForOutbox(
  scenario: string,
  predicate: (status: OutboxStatus) => boolean,
): Promise<OutboxStatus> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const current = await outboxStatus(scenario);
    if (predicate(current)) return current;
    await Bun.sleep(50);
  }
  const observed = await outboxStatus(`${scenario}-deadline-observation`);
  emit({
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
    ...receiptMetrics(),
    lock_wait_ms: null,
    retry_count: observed.delivery_attempts,
    assertion_diff: `pending=${observed.pending};delivered=${observed.delivered};quarantined=${observed.quarantined};phase=${observed.last_phase}`,
    status: "fail",
    duration_ms: 8_000,
  });
  return fail("S2_OUTBOX_DEADLINE_EXCEEDED");
}

async function expectTransportAbort(
  body: Record<string, unknown>,
  scenario: string,
): Promise<void> {
  try {
    await request("POST", "/__s2/write", scenario, body, 20);
  } catch (error) {
    if (error instanceof Error && error.message === "S2_TRANSPORT_ABORTED") return;
    throw error;
  }
  fail("S2_TRANSPORT_ABORT_EXPECTED");
}

async function assertReplay(
  problemId: string,
  expectedEvents: number,
  scenario: string,
): Promise<void> {
  const replay = await request("POST", "/__s2/replay", scenario, { problem_id: problemId });
  assertEqual(replay.status, 200, "S2_PROJECTION_REPLAY_FAILED");
  assertEqual(booleanAt(replay.body, "matches"), true, "S2_PROJECTION_REPLAY_MISMATCH");
  assertEqual(numberAt(replay.body, "event_count"), expectedEvents, "S2_REPLAY_PAGE_COUNT_INVALID");
}

async function exerciseOutboxDrainer(): Promise<void> {
  await seed(OUTBOX_PROBLEM, "outbox-seed");
  const before = await outboxStatus("outbox-before-auto-handoff");
  const auto = await write(
    writeBody(1, OUTBOX_PROBLEM, "Outbox automatic handoff claim."),
    "outbox-automatic-handoff",
    undefined,
    false,
  );
  assertEqual(auto.outbox_handoff, "armed", "S2_OUTBOX_HANDOFF_NOT_ARMED");
  const afterAuto = await waitForOutbox(
    "outbox-auto-alarm-delivery",
    (status) =>
      status.delivered >= before.delivered + 1 && status.pending === 0 && status.alarm_at === null,
  );
  assertEqual(afterAuto.max_active, 1, "S2_OUTBOX_AUTO_SINGLE_OWNER_INVALID");
  const autoState = await state(OUTBOX_PROBLEM, "outbox-auto-visible-state");
  for (const table of ["claims", "claim_projections", "events", "outbox"] as const) {
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
  const stranded = await outboxStatus("outbox-failed-handoff-visible");
  assertEqual(stranded.pending, 1, "S2_OUTBOX_FAILED_HANDOFF_NOT_PENDING");
  assertEqual(stranded.alarm_at, null, "S2_OUTBOX_FAILED_HANDOFF_BORROWED_ALARM");
  await triggerScheduledOutboxReconcile("outbox-scheduled-reconcile-trigger");
  const afterScheduled = await waitForOutbox(
    "outbox-scheduled-reconcile-delivery",
    (status) =>
      status.delivered >= afterAuto.delivered + 1 &&
      status.pending === 0 &&
      status.alarm_at === null,
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
  const staleArmed = await outboxStatus("outbox-stale-wrap-rearmed");
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
    (status) => status.pending === 0 && status.alarm_at === null,
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
  const heldStatus = await outboxStatus("outbox-kill-boundary-status");
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
  assertEqual(completed.status, 200, "S2_LEGACY_AT_LIMIT_BACKFILL_FAILED");
  assertEqual(stringAt(completed.body, "status"), "complete", "S2_LEGACY_AT_LIMIT_STATUS_INVALID");
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
  assertEqual(upgraded.status, 200, "S2_WRITE_BOUNDARY_BACKFILL_FAILED");

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
  assertEqual(upgraded.status, 200, "S2_MIXED_BACKFILL_FAILED");

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
    assertEqual(upgraded.status, 200, "S2_PREFLIGHT_SUBJECT_BACKFILL_FAILED");
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
  assertEqual(firstBackfill.status, 200, "S2_UPGRADE_EXISTING_BACKFILL_FAILED");
  assertEqual(firstBackfill.body.status, "complete", "S2_UPGRADE_EXISTING_BACKFILL_STATUS_INVALID");
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
  assertEqual(secondBackfill.status, 200, "S2_UPGRADE_EXISTING_BACKFILL_RERUN_FAILED");

  const restored = await state(UPGRADE_EXISTING_PROBLEM, "upgrade-existing-restored-state");
  assertEqual(restored.cursor, 1, "S2_UPGRADE_EXISTING_CURSOR_INVALID");
  assertEqual(restored.counts.events, 1, "S2_UPGRADE_EXISTING_EVENT_COUNT_INVALID");
  assertEqual(
    restored.counts.integrity_checkpoints,
    1,
    "S2_UPGRADE_EXISTING_CHECKPOINT_COUNT_INVALID",
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
  assertEqual(upgraded.counts.integrity_checkpoints, 1, "S2_UPGRADE_EMPTY_CHECKPOINT_INVALID");
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
    "idempotency",
    "outbox",
    "integrity_checkpoints",
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
  const eventRows = events.body.events;
  if (!Array.isArray(eventRows) || eventRows.length !== 13) fail("S2_EVENT_PAGE_INVALID");

  const fts = await request("GET", "/__s2/search?q=Synthetic&limit=20", "fts-read");
  assertEqual(fts.status, 200, "S2_FTS_QUERY_FAILED");
  const ftsMatches = fts.body.matches;
  if (!Array.isArray(ftsMatches) || ftsMatches.length !== 13) fail("S2_FTS_RESULT_INVALID");

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

  await assertReplay(PRIMARY_PROBLEM, 13, "replay-primary");
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
    s2_pre_commit_delay_ms: 125,
  };
  await expectTransportAbort(beforeDisconnect, "disconnect-before-commit");
  await Bun.sleep(160);
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

  const readStorm = await Promise.all(
    Array.from({ length: 64 }, () =>
      request("GET", `/__s2/cursor?problem_id=${PRIMARY_PROBLEM}`, "local-read-storm"),
    ),
  );
  for (const read of readStorm) {
    assertEqual(read.status, 200, "S2_READ_STORM_STATUS_INVALID");
    assertEqual(numberAt(read.body, "cursor"), 31, "S2_READ_STORM_CURSOR_INVALID");
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
  for (const table of ["claims", "claim_projections", "events", "outbox"] as const) {
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
    ...receiptMetrics(),
    lock_wait_ms: null,
    retry_count: recoveredOutbox.delivery_attempts,
    assertion_diff: null,
    total_harness_request_count: requestCount,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
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
