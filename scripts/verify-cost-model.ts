/**
 * S-7's deliberately narrow cost-model verifier.
 *
 * It reproduces Fable §15's worked arithmetic and decodes one future, retained
 * S-2 measurement receipt. It intentionally cannot turn a local S-2 result
 * into a deployed-cost or performance claim: all unavailable dimensions remain
 * named unknowns and the verifier's terminal status stays blocked.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  MAX_S2_COST_EVIDENCE_MANIFEST_BYTES,
  MAX_S2_COST_RECEIPT_BYTES,
  parseS2CostEvidenceManifestBytes,
  parseS2CostMeasurementReceiptBytes,
  parseS2CostReceiptPublicationBytes,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_METRIC_SCOPE,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2_FAILED_RETRY_SCOPE,
  S2_LOCAL_SCOPE,
  type S2CostMeasurementReceipt,
  S2CostReceiptContractError,
  S2_SUCCESSFUL_BATCH_SCOPE,
  S2_WRITE_CLAIM_SCOPE,
} from "@asimposium/contracts";
import {
  HARNESS_SCHEMA_VERSION,
  type HarnessEvent,
  validateHarnessEvent,
} from "./harness/runner.ts";

export {
  MAX_S2_COST_RECEIPT_BYTES,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_METRIC_SCOPE,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_PUBLICATION_RECORD,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_PUBLICATION_SCHEMA_VERSION,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2_FAILED_RETRY_SCOPE,
  S2_LOCAL_SCOPE,
  S2_SUCCESSFUL_BATCH_SCOPE,
  S2_WRITE_CLAIM_SCOPE,
  type S2CostMeasurementReceipt,
  type S2CostEvidenceManifest,
  type S2CostReceiptPublication,
} from "@asimposium/contracts";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

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
  | "S2_COST_RECEIPT_UNREADABLE"
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

export function receiptDigest(receiptBytes: Uint8Array): string {
  return createHash("sha256").update(receiptBytes).digest("hex");
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
    if (error instanceof S2CostReceiptContractError || error instanceof CostVerifierError) {
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

/**
 * The reader owns its bounded descriptor lifecycle; this small structural
 * boundary lets its error paths be tested without a scheduler-dependent
 * regular-file race. The CLI never selects an alternate filesystem.
 */
export interface ReceiptFileSystem {
  readonly open: (receiptPath: string) => number;
  readonly fstat: (descriptor: number) => { readonly size: number; isFile(): boolean };
  readonly read: (
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly close: (descriptor: number) => void;
}

function readReceiptBytes(
  receiptPath: string,
  fileSystem: ReceiptFileSystem,
  maximumBytes = MAX_S2_COST_RECEIPT_BYTES,
): Uint8Array {
  let descriptor: number | undefined;
  let bytes: Uint8Array | undefined;
  let failure: unknown;
  try {
    // A blocking read-only open on a FIFO waits forever before fstat can reject
    // it as non-regular. O_NONBLOCK makes every operator-supplied path reach
    // the descriptor-type check under the same bounded CLI contract.
    descriptor = fileSystem.open(receiptPath);
    const before = fileSystem.fstat(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
      throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
    }
    if (before.size > maximumBytes) {
      throw new CostVerifierError("S2_COST_RECEIPT_TOO_LARGE", "receipt exceeds the byte limit.");
    }

    bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fileSystem.read(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) {
        throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt changed while reading.");
      }
      offset += read;
    }

    const after = fileSystem.fstat(descriptor);
    if (!after.isFile() || after.size !== before.size) {
      throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt changed while reading.");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.close(descriptor);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }

  if (failure !== undefined) {
    if (failure instanceof CostVerifierError) throw failure;
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
  }
  if (bytes === undefined) {
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
  }
  return bytes;
}

const NODE_RECEIPT_FILE_SYSTEM: ReceiptFileSystem = {
  open: (receiptPath) => openSync(receiptPath, constants.O_RDONLY | constants.O_NONBLOCK),
  fstat: (descriptor) => fstatSync(descriptor),
  read: (descriptor, buffer, offset, length, position) =>
    readSync(descriptor, buffer, offset, length, position),
  close: (descriptor) => closeSync(descriptor),
};

export function createReceiptReader(fileSystem: ReceiptFileSystem): ReceiptReader {
  return (receiptPath) => readReceiptBytes(receiptPath, fileSystem);
}

const defaultReceiptReader = createReceiptReader(NODE_RECEIPT_FILE_SYSTEM);
const defaultEvidenceReader: ReceiptReader = (receiptPath) =>
  readReceiptBytes(receiptPath, NODE_RECEIPT_FILE_SYSTEM, MAX_S2_COST_EVIDENCE_MANIFEST_BYTES);

interface CliEvidencePaths {
  readonly receipt: string;
  readonly manifest: string;
  readonly publication: string;
}

function parseCliArguments(argv: readonly string[]): CliEvidencePaths | undefined {
  if (argv.length === 0) return undefined;
  if (
    argv.length === 6 &&
    argv[0] === "--receipt" &&
    argv[2] === "--manifest" &&
    argv[4] === "--publication" &&
    argv[1] !== undefined &&
    argv[3] !== undefined &&
    argv[5] !== undefined &&
    argv[1] !== "" &&
    argv[3] !== "" &&
    argv[5] !== ""
  ) {
    return { receipt: argv[1], manifest: argv[3], publication: argv[5] };
  }
  throw new CostVerifierError("COST_MODEL_ARGUMENT_INVALID", "invalid cost-verifier arguments.");
}

function verifyEvidencePaths(paths: CliEvidencePaths): void {
  const receipt = resolve(paths.receipt);
  const root = dirname(receipt);
  if (
    basename(receipt) !== S2_COST_RECEIPT_RELATIVE_PATH ||
    resolve(paths.manifest) !== resolve(root, S2_COST_MANIFEST_RELATIVE_PATH) ||
    resolve(paths.publication) !== resolve(root, S2_COST_PUBLICATION_RELATIVE_PATH)
  ) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt evidence paths are invalid.");
  }
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt evidence root is invalid.");
    }
  } catch (error) {
    if (error instanceof CostVerifierError) throw error;
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt evidence cannot be read.");
  }
}

function attestedReceiptBytes(
  paths: CliEvidencePaths,
  readReceipt: ReceiptReader,
  readEvidence: ReceiptReader,
): { readonly receipt: Uint8Array; readonly provenance: ExpectedReceiptProvenance } {
  verifyEvidencePaths(paths);
  const receipt = readReceipt(paths.receipt);
  const manifestBytes = readEvidence(paths.manifest);
  const publicationBytes = readReceipt(paths.publication);
  const manifest = parseS2CostEvidenceManifestBytes(manifestBytes);
  const publication = parseS2CostReceiptPublicationBytes(publicationBytes);
  const digest = receiptDigest(receipt);
  if (
    manifest.manifest_version !== S2_COST_EVIDENCE_MANIFEST_VERSION ||
    manifest.exit_code !== 78 ||
    manifest.s2_cost_receipt === null ||
    manifest.s2_cost_receipt.path !== S2_COST_RECEIPT_RELATIVE_PATH ||
    manifest.s2_cost_receipt.digest !== digest ||
    manifest.s2_cost_receipt.bytes !== receipt.byteLength ||
    publication.manifest.digest !== receiptDigest(manifestBytes) ||
    publication.receipt.digest !== digest ||
    publication.receipt.bytes !== receipt.byteLength ||
    publication.provenance.run_id !== manifest.run_id ||
    publication.provenance.revision !== manifest.revision ||
    publication.provenance.dirty_state !== manifest.dirty_state ||
    publication.provenance.source_digest !== manifest.source_digest ||
    publication.local_phase_status.exercise !== manifest.local_phase_status.exercise ||
    publication.local_phase_status.restart_verify !== manifest.local_phase_status.restart_verify ||
    publication.local_phase_status.upgrade_existing !== manifest.local_phase_status.upgrade_existing ||
    publication.local_phase_status.upgrade_empty !== manifest.local_phase_status.upgrade_empty ||
    publication.local_phase_status.upgrade_journal_existing !==
      manifest.local_phase_status.upgrade_journal_existing ||
    publication.local_phase_status.upgrade_journal_empty !==
      manifest.local_phase_status.upgrade_journal_empty ||
    Object.values(manifest.local_phase_status).some((status) => status !== "pass")
  ) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt evidence does not attest local phases.");
  }
  return {
    receipt,
    provenance: {
      run_id: manifest.run_id,
      revision: manifest.revision,
      source_digest: manifest.source_digest,
    },
  };
}

function cliFailureResult(error: unknown): CostVerificationResult {
  const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
  if (!(error instanceof CostVerifierError)) {
    return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
  }
  if (error.code === "COST_MODEL_ARGUMENT_INVALID") {
    return unavailableResult(workload, "invalid", "COST_MODEL_ARGUMENT_INVALID");
  }
  if (error.code === "S2_COST_MEASUREMENT_UNAVAILABLE") {
    return unavailableResult(workload, "unavailable", "S2_COST_MEASUREMENT_UNAVAILABLE");
  }
  if (error.code === "S2_COST_RECEIPT_UNREADABLE") {
    return unavailableResult(workload, "unavailable", "S2_COST_RECEIPT_UNREADABLE");
  }
  if (error.code === "S2_COST_RECEIPT_TOO_LARGE") {
    return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_TOO_LARGE");
  }
  return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
}

export function runCostVerifierCli(
  argv: readonly string[] = process.argv.slice(2),
  readReceipt: ReceiptReader = defaultReceiptReader,
  readEvidence: ReceiptReader = defaultEvidenceReader,
): CostVerifierDiagnostic {
  let result: CostVerificationResult;
  try {
    const paths = parseCliArguments(argv);
    if (paths === undefined) {
      result = verifyCostModel();
    } else {
      const attested = attestedReceiptBytes(paths, readReceipt, readEvidence);
      result = verifyCostModel(FABLE_WORKED_EXAMPLE, attested.receipt, attested.provenance);
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
