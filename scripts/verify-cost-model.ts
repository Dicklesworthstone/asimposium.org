/**
 * S-7's deliberately narrow cost-model verifier.
 *
 * It reproduces Fable §15's worked arithmetic and decodes one future, retained
 * S-2 measurement receipt. It intentionally cannot turn a local S-2 result
 * into a deployed-cost or performance claim: all unavailable dimensions remain
 * named unknowns and the verifier's terminal status stays blocked.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { KraterPreflightCost, KraterWriteResult } from "../apps/wire/src/krater/krater.ts";
import {
  HARNESS_SCHEMA_VERSION,
  type HarnessEvent,
  validateHarnessEvent,
} from "./harness/runner.ts";

export const S2_COST_RECEIPT_SCHEMA_VERSION = "s2-cost-input-v1";
export const S2_COST_RECEIPT_RECORD = "s2_cost_measurement";
export const S2_COST_METRIC_SCOPE = "selected-settled-write-receipts";
export const S2_SUCCESSFUL_BATCH_SCOPE = "settled-db.batch-only";
export const S2_FAILED_RETRY_SCOPE = "excluded-d1-error-has-no-meta";
export const S2_WRITE_CLAIM_SCOPE = "writeClaim-entry-to-return";
export const S2_LOCAL_SCOPE = "local-workerd-d1-do";
/** A receipt is metadata, not an artifact body: fail closed before parsing large input. */
export const MAX_S2_COST_RECEIPT_BYTES = 64 * 1024;

export const REQUIRED_ROW_TOTAL_EXCLUSIONS = [
  "head-and-post-write-verification-reads-no-meta",
  "failed-retry-batches-no-meta",
] as const;

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * This names the existing Krater source of the receipt fields. The cost
 * verifier deliberately consumes a normalized aggregate receipt rather than
 * reaching into the S-2 client's private `WriteResult` decoder.
 */
export type S2WriteMetricSource = Pick<
  KraterWriteResult,
  | "successfulBatchRowsRead"
  | "successfulBatchRowsWritten"
  | "successfulBatchSqlMs"
  | "writeClaimWallMs"
  | "retryCount"
> & {
  readonly preflight: Pick<
    KraterPreflightCost,
    "rows_read" | "rows_written" | "sql_ms" | "statements" | "wall_ms"
  >;
};

export interface FableWorkedExampleInput {
  readonly problems: number;
  readonly working_fellows: number;
  readonly active_seconds_per_fellow_day: number;
  readonly pack_cadence_seconds: number;
  readonly workshop_push_cadence_seconds: number;
  readonly promotions_per_fellow_day: number;
  readonly lurkers: number;
  readonly cursor_poll_seconds: number;
}

/** The implicit four active hours are explicit so Fable's approximations reproduce exactly. */
export const FABLE_WORKED_EXAMPLE: FableWorkedExampleInput = {
  problems: 20,
  working_fellows: 80,
  active_seconds_per_fellow_day: 14_400,
  pack_cadence_seconds: 60,
  workshop_push_cadence_seconds: 120,
  promotions_per_fellow_day: 10,
  lurkers: 10_000,
  cursor_poll_seconds: 10,
};

export interface CostModelAssumption {
  readonly code: "FABLE_ACTIVE_TIME_INFERRED";
  readonly status: "inferred";
  readonly active_seconds_per_fellow_day: 14_400;
  readonly active_hours_per_fellow_day: 4;
  readonly basis: string;
}

/**
 * §15 gives the daily read total and cadences but does not state an active-day
 * duration. Four hours is inferred from 19,200 reads / (80 fellows × 60 s).
 */
export const FABLE_WORKED_EXAMPLE_ASSUMPTIONS: readonly CostModelAssumption[] = [
  {
    code: "FABLE_ACTIVE_TIME_INFERRED",
    status: "inferred",
    active_seconds_per_fellow_day: 14_400,
    active_hours_per_fellow_day: 4,
    basis:
      "Derived from Fable §15's 19,200 pack reads/day, 80 working Fellows, and 60-second pack cadence; not stated as a plan input.",
  },
];

export interface FableWorkloadArithmetic {
  readonly problems: number;
  readonly pack_reads_per_day: number;
  readonly workshop_pushes_per_day: number;
  readonly promotions_per_day: number;
  readonly cursor_requests_per_second: number;
  /** Fable §15's stated approximation; retained beside the calculation, not copied into it. */
  readonly fable_stated_cursor_requests_per_second: number;
}

export interface S2CostMeasurementReceipt {
  readonly schema_version: typeof S2_COST_RECEIPT_SCHEMA_VERSION;
  readonly record: typeof S2_COST_RECEIPT_RECORD;
  readonly run_id: string;
  readonly phase: "exercise";
  readonly revision: string;
  readonly dirty_state: "clean" | "dirty";
  readonly source_digest: string;
  readonly scope: typeof S2_LOCAL_SCOPE;
  readonly bindings: {
    readonly d1: "DB";
    readonly durable_object: "KRATER_OUTBOX";
    readonly r2: null;
  };
  readonly status: "pass";
  readonly metric_scope: typeof S2_COST_METRIC_SCOPE;
  readonly write_receipt_count: number;
  readonly successful_batch_metric_scope: typeof S2_SUCCESSFUL_BATCH_SCOPE;
  readonly failed_retry_batch_metrics: typeof S2_FAILED_RETRY_SCOPE;
  readonly write_claim_wall_scope: typeof S2_WRITE_CLAIM_SCOPE;
  readonly p95_write_phase_ms: number;
  readonly p95_preflight_wall_ms: number;
  readonly p95_write_claim_wall_ms: number;
  readonly sum_successful_batch_rows_read: number;
  readonly sum_successful_batch_rows_written: number;
  readonly sum_preflight_rows_read: number;
  readonly sum_preflight_rows_written: number;
  readonly sum_preflight_statements: number;
  readonly sum_retry_count: number;
  readonly known_row_total_exclusions: readonly (typeof REQUIRED_ROW_TOTAL_EXCLUSIONS)[number][];
}

export interface ExpectedReceiptProvenance {
  readonly run_id?: string;
  readonly revision?: string;
  readonly source_digest?: string;
}

export interface ExactObservedRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly unit: "observed rows / selected settled write receipt";
}

export interface AcceptedLocalMeasurement {
  readonly state: "accepted-local";
  readonly artifact_digest: string;
  /** Provenance asserted by the receipt, not the verifier process's current Git state. */
  readonly receipt_provenance: {
    readonly run_id: string;
    readonly revision: string;
    readonly source_digest: string;
    readonly dirty_state: "clean" | "dirty";
  };
  readonly scope: typeof S2_LOCAL_SCOPE;
  readonly bindings: {
    readonly d1: "DB";
    readonly durable_object: "KRATER_OUTBOX";
    readonly r2: null;
  };
  readonly metric_scope: typeof S2_COST_METRIC_SCOPE;
  readonly successful_batch_metric_scope: typeof S2_SUCCESSFUL_BATCH_SCOPE;
  readonly failed_retry_batch_metrics: typeof S2_FAILED_RETRY_SCOPE;
  readonly write_claim_wall_scope: typeof S2_WRITE_CLAIM_SCOPE;
  readonly write_receipt_count: number;
  /** Counters observed in the receipt; none is promoted to a complete D1-row total. */
  readonly measured_counters: {
    readonly write_receipt_count: number;
    readonly sum_successful_batch_rows_read: number;
    readonly sum_successful_batch_rows_written: number;
    readonly sum_preflight_rows_read: number;
    readonly sum_preflight_rows_written: number;
    readonly sum_preflight_statements: number;
    readonly sum_retry_count: number;
  };
  readonly known_settled_batch_rows_read: number;
  readonly known_settled_batch_rows_written: number;
  readonly known_preflight_rows_read: number;
  readonly known_preflight_rows_written: number;
  readonly observed_rows_per_selected_settled_write_receipt: {
    readonly settled_batch_read: ExactObservedRatio;
    readonly settled_batch_written: ExactObservedRatio;
    readonly preflight_read: ExactObservedRatio;
    readonly preflight_written: ExactObservedRatio;
  };
  readonly local_p95_ms: {
    readonly write_phase: number;
    readonly preflight_wall: number;
    readonly write_claim_wall: number;
  };
  readonly known_row_total_exclusions: readonly (typeof REQUIRED_ROW_TOTAL_EXCLUSIONS)[number][];
}

export interface UnavailableMeasurement {
  readonly state: "unavailable" | "invalid";
  readonly artifact_digest: null;
}

export type CostVerificationCode =
  | "S2_COST_MEASUREMENT_UNAVAILABLE"
  | "S2_COST_RECEIPT_INVALID"
  | "S2_COST_RECEIPT_TOO_LARGE"
  | "COST_MODEL_ARGUMENT_INVALID"
  | "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE";

export interface CostVerificationResult {
  readonly status: "blocked";
  readonly code: CostVerificationCode;
  readonly workload: FableWorkloadArithmetic;
  readonly s2: AcceptedLocalMeasurement | UnavailableMeasurement;
  readonly source_discrepancies: readonly SourceDiscrepancy[];
  readonly assumptions: readonly CostModelAssumption[];
  readonly unknowns: readonly string[];
}

export interface SourceDiscrepancy {
  readonly code: "FABLE_CURSOR_RATE_MISMATCH";
  readonly stated: number;
  readonly computed: number;
  readonly unit: "requests / second";
}

export class CostVerifierError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CostVerifierError";
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!isSafeInteger(value)) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      `${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new CostVerifierError("WORKLOAD_INPUT_INVALID", `${field} must be positive.`);
  }
  return parsed;
}

function checkedProduct(left: number, right: number, field: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      `${field} exceeds the safe integer range.`,
    );
  }
  return product;
}

function exactQuotient(numerator: number, denominator: number, field: string): number {
  if (numerator % denominator !== 0) {
    throw new CostVerifierError(
      "WORKLOAD_CADENCE_NOT_INTEGRAL",
      `${field} would require rounding, which this verifier forbids.`,
    );
  }
  return numerator / denominator;
}

export function calculateFableWorkload(input: FableWorkedExampleInput): FableWorkloadArithmetic {
  const problems = requirePositiveInteger(input.problems, "problems");
  const fellows = requireNonNegativeInteger(input.working_fellows, "working_fellows");
  const activeSeconds = requirePositiveInteger(
    input.active_seconds_per_fellow_day,
    "active_seconds_per_fellow_day",
  );
  if (activeSeconds > 86_400) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      "active_seconds_per_fellow_day must not exceed one day.",
    );
  }
  const packCadence = requirePositiveInteger(input.pack_cadence_seconds, "pack_cadence_seconds");
  const workshopCadence = requirePositiveInteger(
    input.workshop_push_cadence_seconds,
    "workshop_push_cadence_seconds",
  );
  const promotionsPerFellow = requireNonNegativeInteger(
    input.promotions_per_fellow_day,
    "promotions_per_fellow_day",
  );
  const lurkers = requireNonNegativeInteger(input.lurkers, "lurkers");
  const cursorPoll = requirePositiveInteger(input.cursor_poll_seconds, "cursor_poll_seconds");

  const activeFellowSeconds = checkedProduct(
    fellows,
    activeSeconds,
    "working_fellows × active_seconds_per_fellow_day",
  );
  return {
    problems,
    pack_reads_per_day: exactQuotient(activeFellowSeconds, packCadence, "pack_reads_per_day"),
    workshop_pushes_per_day: exactQuotient(
      activeFellowSeconds,
      workshopCadence,
      "workshop_pushes_per_day",
    ),
    promotions_per_day: checkedProduct(
      fellows,
      promotionsPerFellow,
      "working_fellows × promotions_per_fellow_day",
    ),
    cursor_requests_per_second: exactQuotient(lurkers, cursorPoll, "cursor_requests_per_second"),
    fable_stated_cursor_requests_per_second: 100,
  };
}

function sourceDiscrepancies(workload: FableWorkloadArithmetic): readonly SourceDiscrepancy[] {
  if (workload.cursor_requests_per_second === workload.fable_stated_cursor_requests_per_second) {
    return [];
  }
  return [
    {
      code: "FABLE_CURSOR_RATE_MISMATCH",
      stated: workload.fable_stated_cursor_requests_per_second,
      computed: workload.cursor_requests_per_second,
      unit: "requests / second",
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt must be an object.");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", `${field} must be a string.`);
  }
  return value;
}

function requireExactString(
  record: Record<string, unknown>,
  field: string,
  expected: string,
): string {
  const value = requireString(record, field);
  if (value !== expected) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", `${field} has an unexpected scope.`);
  }
  return value;
}

function requireReceiptCount(record: Record<string, unknown>, field: string, minimum = 0): number {
  const value = record[field];
  if (!isSafeInteger(value) || value < minimum) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", `${field} must be a bounded count.`);
  }
  return value;
}

function requireMilliseconds(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CostVerifierError(
      "S2_COST_RECEIPT_INVALID",
      `${field} must be non-negative milliseconds.`,
    );
  }
  return value;
}

function parseBindings(value: unknown): S2CostMeasurementReceipt["bindings"] {
  const bindings = asRecord(value);
  if (bindings.d1 !== "DB" || bindings.durable_object !== "KRATER_OUTBOX" || bindings.r2 !== null) {
    throw new CostVerifierError(
      "S2_COST_RECEIPT_INVALID",
      "receipt bindings have an unexpected scope.",
    );
  }
  return { d1: "DB", durable_object: "KRATER_OUTBOX", r2: null };
}

function parseExclusions(
  value: unknown,
): readonly (typeof REQUIRED_ROW_TOTAL_EXCLUSIONS)[number][] {
  if (
    !Array.isArray(value) ||
    value.length !== REQUIRED_ROW_TOTAL_EXCLUSIONS.length ||
    value.some((entry, index) => entry !== REQUIRED_ROW_TOTAL_EXCLUSIONS[index])
  ) {
    throw new CostVerifierError(
      "S2_COST_RECEIPT_INVALID",
      "receipt must declare the exact known row-total exclusions.",
    );
  }
  return REQUIRED_ROW_TOTAL_EXCLUSIONS;
}

function parseS2CostMeasurementReceiptValue(value: unknown): S2CostMeasurementReceipt {
  const receipt = asRecord(value);
  requireExactString(receipt, "schema_version", S2_COST_RECEIPT_SCHEMA_VERSION);
  requireExactString(receipt, "record", S2_COST_RECEIPT_RECORD);
  const runId = requireString(receipt, "run_id");
  const revision = requireString(receipt, "revision");
  const sourceDigest = requireString(receipt, "source_digest");
  if (!SAFE_COMPONENT.test(runId) || !GIT_REVISION.test(revision) || !SHA256.test(sourceDigest)) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt provenance is malformed.");
  }
  const dirtyState = requireString(receipt, "dirty_state");
  if (dirtyState !== "clean" && dirtyState !== "dirty") {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt dirty_state is invalid.");
  }
  requireExactString(receipt, "phase", "exercise");
  requireExactString(receipt, "scope", S2_LOCAL_SCOPE);
  requireExactString(receipt, "status", "pass");
  requireExactString(receipt, "metric_scope", S2_COST_METRIC_SCOPE);
  requireExactString(receipt, "successful_batch_metric_scope", S2_SUCCESSFUL_BATCH_SCOPE);
  requireExactString(receipt, "failed_retry_batch_metrics", S2_FAILED_RETRY_SCOPE);
  requireExactString(receipt, "write_claim_wall_scope", S2_WRITE_CLAIM_SCOPE);

  return {
    schema_version: S2_COST_RECEIPT_SCHEMA_VERSION,
    record: S2_COST_RECEIPT_RECORD,
    run_id: runId,
    phase: "exercise",
    revision,
    dirty_state: dirtyState,
    source_digest: sourceDigest,
    scope: S2_LOCAL_SCOPE,
    bindings: parseBindings(receipt.bindings),
    status: "pass",
    metric_scope: S2_COST_METRIC_SCOPE,
    write_receipt_count: requireReceiptCount(receipt, "write_receipt_count", 1),
    successful_batch_metric_scope: S2_SUCCESSFUL_BATCH_SCOPE,
    failed_retry_batch_metrics: S2_FAILED_RETRY_SCOPE,
    write_claim_wall_scope: S2_WRITE_CLAIM_SCOPE,
    p95_write_phase_ms: requireMilliseconds(receipt, "p95_write_phase_ms"),
    p95_preflight_wall_ms: requireMilliseconds(receipt, "p95_preflight_wall_ms"),
    p95_write_claim_wall_ms: requireMilliseconds(receipt, "p95_write_claim_wall_ms"),
    sum_successful_batch_rows_read: requireReceiptCount(receipt, "sum_successful_batch_rows_read"),
    sum_successful_batch_rows_written: requireReceiptCount(
      receipt,
      "sum_successful_batch_rows_written",
    ),
    sum_preflight_rows_read: requireReceiptCount(receipt, "sum_preflight_rows_read"),
    sum_preflight_rows_written: requireReceiptCount(receipt, "sum_preflight_rows_written"),
    sum_preflight_statements: requireReceiptCount(receipt, "sum_preflight_statements"),
    sum_retry_count: requireReceiptCount(receipt, "sum_retry_count"),
    known_row_total_exclusions: parseExclusions(receipt.known_row_total_exclusions),
  };
}

export function receiptDigest(receiptBytes: Uint8Array): string {
  return createHash("sha256").update(receiptBytes).digest("hex");
}

/**
 * Receipt bytes are the sole verifier input. The parser deliberately lives at
 * this boundary, so a pre-parsed object can never disagree with the bytes that
 * are digested and reported as the local artifact.
 */
export function parseS2CostMeasurementReceiptBytes(
  receiptBytes: Uint8Array,
): S2CostMeasurementReceipt {
  if (!(receiptBytes instanceof Uint8Array)) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt must be UTF-8 JSON bytes.");
  }
  if (receiptBytes.byteLength > MAX_S2_COST_RECEIPT_BYTES) {
    throw new CostVerifierError("S2_COST_RECEIPT_TOO_LARGE", "receipt exceeds the byte limit.");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)) as unknown;
  } catch {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt is not valid JSON.");
  }
  return parseS2CostMeasurementReceiptValue(value);
}

function assertExpectedProvenance(
  receipt: S2CostMeasurementReceipt,
  expected: ExpectedReceiptProvenance | undefined,
): void {
  if (expected !== undefined) {
    if (
      (expected.run_id !== undefined && receipt.run_id !== expected.run_id) ||
      (expected.revision !== undefined && receipt.revision !== expected.revision) ||
      (expected.source_digest !== undefined && receipt.source_digest !== expected.source_digest)
    ) {
      throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt provenance does not match.");
    }
  }
}

function ratio(numerator: number, denominator: number): ExactObservedRatio {
  return {
    numerator,
    denominator,
    unit: "observed rows / selected settled write receipt",
  };
}

const COST_MODEL_UNKNOWNS = [
  "complete_write_row_totals",
  "pack_delta_and_cursor_rows",
  "worker_cpu_ms",
  "r2_operations_and_storage",
  "durable_object_alarm_cost",
  "edge_cache_hit_rate",
  "deployed_traffic",
  "provider_price",
  "route_to_receipt_mapping",
  "deployed_performance_budget_verdict",
] as const;

function unavailableResult(
  workload: FableWorkloadArithmetic,
  state: UnavailableMeasurement["state"],
  code: CostVerificationCode,
): CostVerificationResult {
  return {
    status: "blocked",
    code,
    workload,
    s2: { state, artifact_digest: null },
    source_discrepancies: sourceDiscrepancies(workload),
    assumptions: FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
    unknowns: COST_MODEL_UNKNOWNS,
  };
}

export function verifyCostModel(
  workloadInput: FableWorkedExampleInput = FABLE_WORKED_EXAMPLE,
  receiptBytes?: Uint8Array,
  expectedProvenance?: ExpectedReceiptProvenance,
): CostVerificationResult {
  const workload = calculateFableWorkload(workloadInput);
  if (receiptBytes === undefined) {
    return unavailableResult(workload, "unavailable", "S2_COST_MEASUREMENT_UNAVAILABLE");
  }

  let receipt: S2CostMeasurementReceipt;
  try {
    receipt = parseS2CostMeasurementReceiptBytes(receiptBytes);
    assertExpectedProvenance(receipt, expectedProvenance);
  } catch (error) {
    if (error instanceof CostVerifierError) {
      const code =
        error.code === "S2_COST_RECEIPT_TOO_LARGE"
          ? "S2_COST_RECEIPT_TOO_LARGE"
          : "S2_COST_RECEIPT_INVALID";
      return unavailableResult(workload, "invalid", code);
    }
    throw error;
  }

  const count = receipt.write_receipt_count;
  return {
    // A local Workerd receipt is calculation evidence only. It cannot validate §15's deployed
    // p95, edge-cache, CPU, R2, DO, or price claims, so even an accepted receipt remains blocked.
    status: "blocked",
    code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
    workload,
    s2: {
      state: "accepted-local",
      artifact_digest: receiptDigest(receiptBytes),
      receipt_provenance: {
        run_id: receipt.run_id,
        revision: receipt.revision,
        source_digest: receipt.source_digest,
        dirty_state: receipt.dirty_state,
      },
      scope: receipt.scope,
      bindings: receipt.bindings,
      metric_scope: receipt.metric_scope,
      successful_batch_metric_scope: receipt.successful_batch_metric_scope,
      failed_retry_batch_metrics: receipt.failed_retry_batch_metrics,
      write_claim_wall_scope: receipt.write_claim_wall_scope,
      write_receipt_count: count,
      measured_counters: {
        write_receipt_count: count,
        sum_successful_batch_rows_read: receipt.sum_successful_batch_rows_read,
        sum_successful_batch_rows_written: receipt.sum_successful_batch_rows_written,
        sum_preflight_rows_read: receipt.sum_preflight_rows_read,
        sum_preflight_rows_written: receipt.sum_preflight_rows_written,
        sum_preflight_statements: receipt.sum_preflight_statements,
        sum_retry_count: receipt.sum_retry_count,
      },
      known_settled_batch_rows_read: receipt.sum_successful_batch_rows_read,
      known_settled_batch_rows_written: receipt.sum_successful_batch_rows_written,
      known_preflight_rows_read: receipt.sum_preflight_rows_read,
      known_preflight_rows_written: receipt.sum_preflight_rows_written,
      observed_rows_per_selected_settled_write_receipt: {
        settled_batch_read: ratio(receipt.sum_successful_batch_rows_read, count),
        settled_batch_written: ratio(receipt.sum_successful_batch_rows_written, count),
        preflight_read: ratio(receipt.sum_preflight_rows_read, count),
        preflight_written: ratio(receipt.sum_preflight_rows_written, count),
      },
      local_p95_ms: {
        write_phase: receipt.p95_write_phase_ms,
        preflight_wall: receipt.p95_preflight_wall_ms,
        write_claim_wall: receipt.p95_write_claim_wall_ms,
      },
      known_row_total_exclusions: receipt.known_row_total_exclusions,
    },
    source_discrepancies: sourceDiscrepancies(workload),
    assumptions: FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
    unknowns: COST_MODEL_UNKNOWNS,
  };
}

export interface CostVerifierDiagnostic extends HarnessEvent {
  readonly cost_model: CostVerificationResult;
}

export function buildCostVerifierDiagnostic(
  result: CostVerificationResult,
  runId = "cost-model",
): CostVerifierDiagnostic {
  if (!SAFE_COMPONENT.test(runId)) {
    throw new CostVerifierError("COST_MODEL_ARGUMENT_INVALID", "run_id must be safe.");
  }
  const now = new Date().toISOString();
  const accepted = result.s2.state === "accepted-local" ? result.s2 : undefined;
  const runIdentity = receiptDigest(
    new TextEncoder().encode(
      JSON.stringify({
        runId,
        workload: result.workload,
        receipt: accepted?.artifact_digest ?? "unavailable",
      }),
    ),
  );
  const event: CostVerifierDiagnostic = {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "summary",
    run_id: runId,
    run_identity_digest: runIdentity,
    suite: "s7-cost-verifier",
    scenario: "fable-worked-example",
    step: "cost-model",
    seed: 0,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 1,
    retry: 0,
    replay_safe: true,
    // This direct checker does not create a retained OPS.2a artifact; a later wrapper may do so.
    storage_authority: "simulation",
    adapter: "process",
    status: "blocked",
    code: result.code,
    reproduce: "unavailable: no registered CLI scenario",
    git_revision: "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions:
        accepted === undefined
          ? {}
          : {
              d1: accepted.bindings.d1,
              durable_object: accepted.bindings.durable_object,
              r2: "unavailable",
            },
    },
    http_method: null,
    route_template: null,
    cursor: null,
    seq: null,
    ...(accepted === undefined ? {} : { artifact_digest: accepted.artifact_digest }),
    detail:
      "Arithmetic and local S2 subtotals are reported without a cost or deployed-performance claim.",
    cost_model: result,
  };
  validateHarnessEvent(event);
  return event;
}

export type ReceiptReader = (receiptPath: string) => Uint8Array;

function readReceiptBytes(receiptPath: string): Uint8Array {
  try {
    return readFileSync(receiptPath);
  } catch {
    throw new CostVerifierError("S2_COST_MEASUREMENT_UNAVAILABLE", "receipt cannot be read.");
  }
}

function parseCliArguments(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--receipt" && argv[1] !== undefined && argv[1] !== "") {
    return argv[1];
  }
  throw new CostVerifierError("COST_MODEL_ARGUMENT_INVALID", "invalid cost-verifier arguments.");
}

function cliFailureResult(error: unknown): CostVerificationResult {
  const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
  if (!(error instanceof CostVerifierError)) {
    return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
  }
  switch (error.code) {
    case "COST_MODEL_ARGUMENT_INVALID":
      return unavailableResult(workload, "invalid", "COST_MODEL_ARGUMENT_INVALID");
    case "S2_COST_MEASUREMENT_UNAVAILABLE":
      return unavailableResult(workload, "unavailable", "S2_COST_MEASUREMENT_UNAVAILABLE");
    case "S2_COST_RECEIPT_TOO_LARGE":
      return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_TOO_LARGE");
    default:
      return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
  }
}

export function runCostVerifierCli(
  argv: readonly string[] = process.argv.slice(2),
  readReceipt: ReceiptReader = readReceiptBytes,
): CostVerifierDiagnostic {
  let result: CostVerificationResult;
  try {
    const receiptPath = parseCliArguments(argv);
    if (receiptPath === undefined) {
      result = verifyCostModel();
    } else {
      result = verifyCostModel(FABLE_WORKED_EXAMPLE, readReceipt(receiptPath));
    }
  } catch (error) {
    result = cliFailureResult(error);
  }
  return buildCostVerifierDiagnostic(result);
}

if (import.meta.main) {
  const diagnostic = runCostVerifierCli();
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 78;
}
