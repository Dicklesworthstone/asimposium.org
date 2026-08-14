import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildS2CostMeasurementReceipt,
  type S2CostReceiptProvenance,
  type S2SettledWriteResult,
} from "../apps/wire/src/krater/s2-client.ts";
import {
  buildCostVerifierDiagnostic,
  calculateFableWorkload,
  createReceiptReader,
  FABLE_WORKED_EXAMPLE,
  FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
  MAX_S2_COST_RECEIPT_BYTES,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  type ReceiptFileSystem,
  receiptDigest,
  runCostVerifierCli,
  S2_COST_METRIC_SCOPE,
  S2_COST_PUBLICATION_RECORD,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_PUBLICATION_SCHEMA_VERSION,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2_FAILED_RETRY_SCOPE,
  S2_LOCAL_SCOPE,
  S2_SUCCESSFUL_BATCH_SCOPE,
  S2_WRITE_CLAIM_SCOPE,
  type S2CostMeasurementReceipt,
  verifyCostModel,
} from "./verify-cost-model.ts";

const REVISION = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const PRODUCER_PROVENANCE: S2CostReceiptProvenance = {
  run_id: "s2-cost-producer",
  revision: REVISION,
  dirty_state: "clean",
  source_digest: SOURCE_DIGEST,
};
function producerWrite(
  index: number,
  rowsRead: number,
  rowsWritten: number,
  writePhaseMs: number,
  writeClaimWallMs: number,
  retryCount: number,
  preflightRowsRead: number,
  preflightRowsWritten: number,
  preflightStatements: number,
  preflightWallMs: number,
): S2SettledWriteResult {
  const hex = index.toString(16);
  return {
    event_id: `E-s2-${String(index).padStart(3, "0")}`,
    seq: index,
    idempotent: false,
    pre_cursor: index - 1,
    post_cursor: index,
    payload_sha256: hex.repeat(64),
    row_digest: hex.repeat(64),
    build_digest: hex.repeat(64),
    chain_digest: hex.repeat(64),
    checkpoint_digest: hex.repeat(64),
    write_phase_ms: writePhaseMs,
    successful_batch_rows_read: rowsRead,
    successful_batch_rows_written: rowsWritten,
    successful_batch_sql_ms: index,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: preflightRowsRead,
    preflight_rows_written: preflightRowsWritten,
    preflight_sql_ms: index,
    preflight_wall_ms: preflightWallMs,
    preflight_statements: preflightStatements,
    preflight_fast_path: true,
    write_claim_wall_ms: writeClaimWallMs,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: retryCount,
    outbox_handoff: "armed",
  };
}

const PRODUCER_WRITES: readonly S2SettledWriteResult[] = [
  producerWrite(1, 3, 2, 1, 100, 0, 4, 0, 3, 10),
  producerWrite(2, 5, 4, 20, 110, 1, 6, 1, 4, 5),
  producerWrite(3, 7, 6, 9, 90, 2, 8, 0, 5, 7),
];

function validReceipt(overrides: Partial<S2CostMeasurementReceipt> = {}): S2CostMeasurementReceipt {
  return {
    schema_version: S2_COST_RECEIPT_SCHEMA_VERSION,
    record: S2_COST_RECEIPT_RECORD,
    run_id: "s2-cost-fixture",
    phase: "exercise",
    revision: REVISION,
    dirty_state: "clean",
    source_digest: SOURCE_DIGEST,
    scope: S2_LOCAL_SCOPE,
    bindings: { d1: "DB", durable_object: "KRATER_OUTBOX", r2: null },
    status: "pass",
    metric_scope: S2_COST_METRIC_SCOPE,
    write_receipt_count: 3,
    successful_batch_metric_scope: S2_SUCCESSFUL_BATCH_SCOPE,
    failed_retry_batch_metrics: S2_FAILED_RETRY_SCOPE,
    write_claim_wall_scope: S2_WRITE_CLAIM_SCOPE,
    p95_write_phase_ms: 111.5,
    p95_preflight_wall_ms: 12.5,
    p95_write_claim_wall_ms: 156.5,
    sum_successful_batch_rows_read: 30,
    sum_successful_batch_rows_written: 12,
    sum_preflight_rows_read: 9,
    sum_preflight_rows_written: 0,
    sum_preflight_statements: 9,
    sum_retry_count: 1,
    known_row_total_exclusions: REQUIRED_ROW_TOTAL_EXCLUSIONS,
    ...overrides,
  };
}

function receiptText(receipt = validReceipt()): string {
  return JSON.stringify(receipt);
}

function receiptBytes(receipt = validReceipt()): Uint8Array {
  return new TextEncoder().encode(receiptText(receipt));
}

function verifiedFixture(
  receipt = validReceipt(),
  expected = {
    run_id: receipt.run_id,
    revision: receipt.revision,
    source_digest: receipt.source_digest,
  },
) {
  const bytes = receiptBytes(receipt);
  return verifyCostModel(FABLE_WORKED_EXAMPLE, bytes, expected);
}

function mutableReceipt(): Record<string, unknown> {
  return structuredClone(validReceipt()) as unknown as Record<string, unknown>;
}

function assertInvalidReceipt(receipt: Record<string, unknown>): void {
  expect(
    verifyCostModel(FABLE_WORKED_EXAMPLE, new TextEncoder().encode(JSON.stringify(receipt))),
  ).toMatchObject({ status: "blocked", code: "S2_COST_RECEIPT_INVALID" });
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("CLI did not emit JSON.");
  }
}

const ALL_LOCAL_PHASES = {
  exercise: "pass",
  restart_verify: "pass",
  upgrade_existing: "pass",
  upgrade_empty: "pass",
  upgrade_journal_existing: "pass",
  upgrade_journal_empty: "pass",
} as const;

interface CliEvidence {
  readonly root: string;
  readonly receiptPath: string;
  readonly manifestPath: string;
  readonly publicationPath: string;
  readonly args: readonly string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCliEvidence(
  contents: string | Uint8Array,
  options: { readonly receipt?: "file" | "missing" | "directory" | "fifo" } = {},
): CliEvidence {
  const root = mkdtempSync(join(tmpdir(), "asimposium-s7-cost-"));
  const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);
  const manifestPath = join(root, S2_COST_MANIFEST_RELATIVE_PATH);
  const publicationPath = join(root, S2_COST_PUBLICATION_RELATIVE_PATH);
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const receiptKind = options.receipt ?? "file";
  if (receiptKind === "file") {
    writeFileSync(receiptPath, bytes, { mode: 0o600 });
  } else if (receiptKind === "directory") {
    mkdirSync(receiptPath, { mode: 0o700 });
  } else if (receiptKind === "fifo") {
    const mkfifo = Bun.spawnSync({ cmd: ["mkfifo", receiptPath], stdout: "pipe", stderr: "pipe" });
    expect(mkfifo.exitCode).toBe(0);
  }
  const manifest = {
    manifest_version: S2_COST_EVIDENCE_MANIFEST_VERSION,
    run_id: "s2-cost-fixture",
    revision: REVISION,
    dirty_state: "clean",
    source_digest: SOURCE_DIGEST,
    exit_code: 78,
    local_phase_status: ALL_LOCAL_PHASES,
    retention: {
      retained: true,
      deletion_performed: false,
      max_bytes_per_run: 1_000_000,
      max_files_per_run: 16,
      retained_bytes_before_manifest: bytes.byteLength,
      retained_files_before_manifest: receiptKind === "file" ? 1 : 0,
    },
    s2_cost_receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    },
    files: [],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const publication = {
    schema_version: S2_COST_PUBLICATION_SCHEMA_VERSION,
    record: S2_COST_PUBLICATION_RECORD,
    manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: sha256(manifestBytes) },
    receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    },
    provenance: {
      run_id: manifest.run_id,
      revision: manifest.revision,
      dirty_state: manifest.dirty_state,
      source_digest: manifest.source_digest,
    },
    local_phase_status: ALL_LOCAL_PHASES,
  };
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(publicationPath, JSON.stringify(publication), { mode: 0o600 });
  return {
    root,
    receiptPath,
    manifestPath,
    publicationPath,
    args: [
      "--receipt",
      receiptPath,
      "--manifest",
      manifestPath,
      "--publication",
      publicationPath,
    ],
  };
}

function rewriteAttestedManifest(
  evidence: CliEvidence,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const manifest = JSON.parse(readFileSync(evidence.manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const publication = JSON.parse(readFileSync(evidence.publicationPath, "utf8")) as {
    manifest: { digest: string };
  };
  publication.manifest.digest = sha256(manifestBytes);
  writeFileSync(evidence.manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(evidence.publicationPath, JSON.stringify(publication), { mode: 0o600 });
}

function runStandaloneCli(args: readonly string[]) {
  const completed = Bun.spawnSync({
    cmd: [process.execPath, "scripts/verify-cost-model.ts", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
  });
  return {
    exitCode: completed.exitCode,
    stdout: new TextDecoder().decode(completed.stdout),
    stderr: new TextDecoder().decode(completed.stderr),
  };
}

interface ReceiptFileSystemCalls {
  open: number;
  fstat: number;
  read: number;
  close: number;
}

function freshReceiptFileSystemCalls(): ReceiptFileSystemCalls {
  return { open: 0, fstat: 0, read: 0, close: 0 };
}

function regularFileStat(size: number): { readonly size: number; isFile(): boolean } {
  return { size, isFile: () => true };
}

function finalFstatChangedFileSystem(
  bytes: Uint8Array,
  finalSize: number,
  calls: ReceiptFileSystemCalls,
  expectedPath: string,
): ReceiptFileSystem {
  return {
    open: (receiptPath) => {
      calls.open += 1;
      expect(receiptPath).toBe(expectedPath);
      return 41;
    },
    fstat: (descriptor) => {
      calls.fstat += 1;
      expect(descriptor).toBe(41);
      return regularFileStat(calls.fstat === 1 ? bytes.byteLength : finalSize);
    },
    read: (descriptor, buffer, offset, length, position) => {
      calls.read += 1;
      expect(descriptor).toBe(41);
      expect(offset).toBe(0);
      expect(length).toBe(bytes.byteLength);
      expect(position).toBe(0);
      buffer.set(bytes);
      return bytes.byteLength;
    },
    close: (descriptor) => {
      calls.close += 1;
      expect(descriptor).toBe(41);
    },
  };
}

function assertUnreadableDiagnostic(
  diagnostic: ReturnType<typeof runCostVerifierCli>,
  forbidden: readonly string[],
): void {
  expect(diagnostic).toMatchObject({
    status: "blocked",
    code: "S2_COST_RECEIPT_UNREADABLE",
    cost_model: {
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
      s2: { state: "unavailable", artifact_digest: null },
    },
  });
  const serialized = JSON.stringify(diagnostic);
  for (const value of forbidden) expect(serialized).not.toContain(value);
}

describe("S7 cost verifier", () => {
  test("reproduces the derived worked-example arithmetic and exposes Fable's cursor mismatch", () => {
    expect(calculateFableWorkload(FABLE_WORKED_EXAMPLE)).toEqual({
      problems: 20,
      pack_reads_per_day: 19_200,
      workshop_pushes_per_day: 9_600,
      promotions_per_day: 800,
      cursor_requests_per_second: 1_000,
      fable_stated_cursor_requests_per_second: 100,
    });
    expect(verifyCostModel().source_discrepancies).toEqual([
      {
        code: "FABLE_CURSOR_RATE_MISMATCH",
        stated: 100,
        computed: 1_000,
        unit: "requests / second",
      },
    ]);
    expect(verifyCostModel().assumptions).toEqual(FABLE_WORKED_EXAMPLE_ASSUMPTIONS);
  });

  test("rejects non-integral cadence rather than rounding", () => {
    let error: unknown;
    try {
      calculateFableWorkload({ ...FABLE_WORKED_EXAMPLE, pack_cadence_seconds: 77 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "WORKLOAD_CADENCE_NOT_INTEGRAL" });
  });

  test("parses and reports the exact receipt bytes as the sole authority", () => {
    const accepted = verifiedFixture();
    expect(accepted.code).toBe("COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE");
    expect(accepted.s2).toMatchObject({
      state: "accepted-local",
      scope: S2_LOCAL_SCOPE,
      metric_scope: S2_COST_METRIC_SCOPE,
      write_receipt_count: 3,
    });

    const originalBytes = receiptBytes();
    const changedBytes = receiptBytes(validReceipt({ sum_retry_count: 2 }));
    const original = verifyCostModel(FABLE_WORKED_EXAMPLE, originalBytes);
    const changed = verifyCostModel(FABLE_WORKED_EXAMPLE, changedBytes);
    if (original.s2.state !== "accepted-local" || changed.s2.state !== "accepted-local") {
      throw new Error("valid byte fixtures were not accepted");
    }
    expect(changed.s2.artifact_digest).not.toBe(original.s2.artifact_digest);
    expect(original.s2.measured_counters.sum_retry_count).toBe(1);
    expect(changed.s2.measured_counters.sum_retry_count).toBe(2);

    const invalid = verifyCostModel(
      FABLE_WORKED_EXAMPLE,
      receiptBytes(
        validReceipt({
          write_receipt_count: 0,
        }),
      ),
    );
    expect(invalid).toMatchObject({ status: "blocked", code: "S2_COST_RECEIPT_INVALID" });
  });

  test("accepts the normalized S2 producer receipt but preserves the terminal exit-78 boundary", () => {
    const privateBodySentinel = "s2-private-body-must-not-echo";
    const metricsWithPrivateBody: readonly (
      | S2SettledWriteResult
      | (S2SettledWriteResult & { readonly privateBody: string })
    )[] = [
      { ...PRODUCER_WRITES[0]!, privateBody: privateBodySentinel },
      ...PRODUCER_WRITES.slice(1),
    ];
    const receipt = buildS2CostMeasurementReceipt(
      metricsWithPrivateBody,
      PRODUCER_PROVENANCE,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const result = verifyCostModel(FABLE_WORKED_EXAMPLE, bytes, PRODUCER_PROVENANCE);
    const evidence = writeCliEvidence(bytes);
    const cli = runStandaloneCli(evidence.args);

    expect(result).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
      s2: {
        state: "accepted-local",
        receipt_provenance: PRODUCER_PROVENANCE,
        write_receipt_count: 3,
        measured_counters: {
          sum_successful_batch_rows_read: 15,
          sum_successful_batch_rows_written: 12,
          sum_preflight_rows_read: 18,
          sum_preflight_rows_written: 1,
          sum_preflight_statements: 12,
          sum_retry_count: 3,
        },
        local_p95_ms: { write_phase: 20, preflight_wall: 10, write_claim_wall: 110 },
      },
      source_discrepancies: [
        { code: "FABLE_CURSOR_RATE_MISMATCH", stated: 100, computed: 1_000 },
      ],
    });
    expect(result.unknowns).toEqual(verifyCostModel().unknowns);
    expect(result.unknowns).toEqual(
      expect.arrayContaining([
        "complete_write_row_totals",
        "route_to_receipt_mapping",
        "worker_cpu_ms",
        "r2_operations_and_storage",
        "durable_object_alarm_cost",
        "provider_price",
        "deployed_performance_budget_verdict",
      ]),
    );
    expect(cli.exitCode).toBe(78);
    expect(parseJsonOutput(cli.stdout)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
      cost_model: { s2: { state: "accepted-local" } },
    });
    // Receipt and CLI diagnostics contain normalized counters only; the S-2
    // request-body sentinel must not be represented or echoed here.
    expect(`${JSON.stringify(receipt)}\n${cli.stdout}\n${cli.stderr}`).not.toContain(
      privateBodySentinel,
    );
  });

  test("carries receipt provenance and measured counters without claiming current Git", () => {
    const result = verifiedFixture(validReceipt({ dirty_state: "dirty" }));
    if (result.s2.state !== "accepted-local") throw new Error("fixture receipt was not accepted");

    expect(result.s2).toMatchObject({
      receipt_provenance: {
        run_id: "s2-cost-fixture",
        revision: REVISION,
        source_digest: SOURCE_DIGEST,
        dirty_state: "dirty",
      },
      measured_counters: {
        write_receipt_count: 3,
        sum_successful_batch_rows_read: 30,
        sum_successful_batch_rows_written: 12,
        sum_preflight_rows_read: 9,
        sum_preflight_rows_written: 0,
        sum_preflight_statements: 9,
        sum_retry_count: 1,
      },
      local_p95_ms: { write_phase: 111.5, preflight_wall: 12.5, write_claim_wall: 156.5 },
    });

    const diagnostic = buildCostVerifierDiagnostic(result, "cost-model-test");
    expect(diagnostic).toMatchObject({
      git_revision: "unavailable",
      cost_model: {
        s2: {
          receipt_provenance: { revision: REVISION, dirty_state: "dirty" },
          measured_counters: { sum_preflight_statements: 9, sum_retry_count: 1 },
        },
      },
    });
  });

  test("labels S2 row metrics as known lower-bound subtotals", () => {
    const result = verifiedFixture();
    if (result.s2.state !== "accepted-local") throw new Error("fixture receipt was not accepted");

    expect(result.s2).toMatchObject({
      known_settled_batch_rows_read: 30,
      known_settled_batch_rows_written: 12,
      known_preflight_rows_read: 9,
      known_preflight_rows_written: 0,
      observed_rows_per_selected_settled_write_receipt: {
        settled_batch_read: { numerator: 30, denominator: 3 },
        preflight_read: { numerator: 9, denominator: 3 },
      },
      known_row_total_exclusions: REQUIRED_ROW_TOTAL_EXCLUSIONS,
    });
    expect(Object.keys(result.s2)).not.toContain("total_d1_rows");
  });

  test("does not map claim-created receipts to workshop or promotion routes", () => {
    const result = verifiedFixture();
    expect(result.unknowns).toContain("route_to_receipt_mapping");
    expect(JSON.stringify(result)).not.toContain("workshop_d1_rows");
    expect(JSON.stringify(result)).not.toContain("promotion_d1_rows");
  });

  test("keeps the same unknowns for unavailable invalid and accepted-local receipts", () => {
    const unavailable = verifyCostModel();
    const invalid = verifyCostModel(FABLE_WORKED_EXAMPLE, new TextEncoder().encode("{"));
    const accepted = verifiedFixture();
    expect(unavailable.unknowns).toEqual(invalid.unknowns);
    expect(accepted.unknowns).toEqual(unavailable.unknowns);
    expect(unavailable.unknowns).toEqual(
      expect.arrayContaining([
        "worker_cpu_ms",
        "r2_operations_and_storage",
        "durable_object_alarm_cost",
        "pack_delta_and_cursor_rows",
        "provider_price",
        "deployed_performance_budget_verdict",
      ]),
    );
    expect(JSON.stringify(accepted)).not.toContain('"worker_cpu_ms":0');
  });

  test("does not treat local p95 as a Fable performance pass", () => {
    const result = verifiedFixture();
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("performance_budget_pass");
  });

  test("emits an OPS.2a-valid redacted event", () => {
    const result = verifiedFixture();
    const diagnostic = buildCostVerifierDiagnostic(result, "cost-model-test");
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toMatchObject({
      schema_version: "1.0",
      record: "summary",
      status: "blocked",
      artifact_digest: receiptDigest(receiptBytes()),
    });
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("asimp_ag_");
    expect(serialized).not.toContain("#v1.");
    expect(serialized).not.toMatch(/authorization|cookie|workshop text/i);
  });

  test("rejects mutations in every receipt scope binding provenance count and p95 guard", () => {
    const mutations: Array<readonly [string, (receipt: Record<string, unknown>) => void]> = [
      [
        "schema",
        (receipt) => {
          receipt.schema_version = "other";
        },
      ],
      [
        "record",
        (receipt) => {
          receipt.record = "other";
        },
      ],
      [
        "phase",
        (receipt) => {
          receipt.phase = "other";
        },
      ],
      [
        "scope",
        (receipt) => {
          receipt.scope = "remote";
        },
      ],
      [
        "status",
        (receipt) => {
          receipt.status = "fail";
        },
      ],
      [
        "metric scope",
        (receipt) => {
          receipt.metric_scope = "all-d1-rows";
        },
      ],
      [
        "successful batch scope",
        (receipt) => {
          receipt.successful_batch_metric_scope = "all";
        },
      ],
      [
        "failed retry scope",
        (receipt) => {
          receipt.failed_retry_batch_metrics = "included";
        },
      ],
      [
        "write claim scope",
        (receipt) => {
          receipt.write_claim_wall_scope = "partial";
        },
      ],
      [
        "binding d1",
        (receipt) => {
          (receipt.bindings as Record<string, unknown>).d1 = "OTHER";
        },
      ],
      [
        "binding durable object",
        (receipt) => {
          (receipt.bindings as Record<string, unknown>).durable_object = "OTHER";
        },
      ],
      [
        "binding r2",
        (receipt) => {
          (receipt.bindings as Record<string, unknown>).r2 = "R2";
        },
      ],
      [
        "root extra key",
        (receipt) => {
          receipt.unexpected = true;
        },
      ],
      [
        "binding extra key",
        (receipt) => {
          (receipt.bindings as Record<string, unknown>).unexpected = true;
        },
      ],
      [
        "run id",
        (receipt) => {
          receipt.run_id = "../bad";
        },
      ],
      [
        "revision",
        (receipt) => {
          receipt.revision = "not-a-revision";
        },
      ],
      [
        "source digest",
        (receipt) => {
          receipt.source_digest = "not-a-digest";
        },
      ],
      [
        "dirty state",
        (receipt) => {
          receipt.dirty_state = "unknown";
        },
      ],
      [
        "write receipt count",
        (receipt) => {
          receipt.write_receipt_count = 0;
        },
      ],
      [
        "successful rows read",
        (receipt) => {
          receipt.sum_successful_batch_rows_read = -1;
        },
      ],
      [
        "successful rows written",
        (receipt) => {
          receipt.sum_successful_batch_rows_written = -1;
        },
      ],
      [
        "preflight rows read",
        (receipt) => {
          receipt.sum_preflight_rows_read = -1;
        },
      ],
      [
        "preflight rows written",
        (receipt) => {
          receipt.sum_preflight_rows_written = -1;
        },
      ],
      [
        "preflight statements",
        (receipt) => {
          receipt.sum_preflight_statements = -1;
        },
      ],
      [
        "retry count",
        (receipt) => {
          receipt.sum_retry_count = -1;
        },
      ],
      [
        "write p95",
        (receipt) => {
          receipt.p95_write_phase_ms = -1;
        },
      ],
      [
        "preflight p95",
        (receipt) => {
          receipt.p95_preflight_wall_ms = -1;
        },
      ],
      [
        "write claim p95",
        (receipt) => {
          receipt.p95_write_claim_wall_ms = -1;
        },
      ],
      [
        "row exclusion",
        (receipt) => {
          receipt.known_row_total_exclusions = ["wrong"];
        },
      ],
    ];

    for (const [_name, mutate] of mutations) {
      const receipt = mutableReceipt();
      mutate(receipt);
      assertInvalidReceipt(receipt);
    }

    for (const expected of [
      { run_id: "other-run" },
      { revision: "c".repeat(40) },
      { source_digest: "d".repeat(64) },
    ]) {
      expect(verifyCostModel(FABLE_WORKED_EXAMPLE, receiptBytes(), expected)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_INVALID",
      });
    }
  });

  test("caps receipt bytes before parsing", () => {
    const oversized = new Uint8Array(MAX_S2_COST_RECEIPT_BYTES + 1);
    expect(verifyCostModel(FABLE_WORKED_EXAMPLE, oversized)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_TOO_LARGE",
    });
  });

  test("deterministically refuses growth and truncation observed by final fstat", () => {
    const bytes = receiptBytes();
    const cases = [
      ["growth", bytes.byteLength + 1],
      ["truncation", bytes.byteLength - 1],
    ] as const;

    for (const [_name, finalSize] of cases) {
      const calls = freshReceiptFileSystemCalls();
      const evidence = writeCliEvidence(bytes);
      const diagnostic = runCostVerifierCli(
        evidence.args,
        createReceiptReader(
          finalFstatChangedFileSystem(bytes, finalSize, calls, evidence.receiptPath),
        ),
      );

      assertUnreadableDiagnostic(diagnostic, [evidence.receiptPath]);
      expect(calls).toEqual({ open: 1, fstat: 2, read: 1, close: 1 });
    }
  });

  test("deterministically maps EACCES to unavailable without touching a descriptor", () => {
    const calls = freshReceiptFileSystemCalls();
    const deniedFileSystem: ReceiptFileSystem = {
      open: () => {
        calls.open += 1;
        const error = new Error("s7-eacces-should-not-echo") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      fstat: () => {
        calls.fstat += 1;
        throw new Error("fstat must not run after EACCES");
      },
      read: () => {
        calls.read += 1;
        throw new Error("read must not run after EACCES");
      },
      close: () => {
        calls.close += 1;
        throw new Error("close must not run after EACCES");
      },
    };

    const evidence = writeCliEvidence(receiptBytes());
    const diagnostic = runCostVerifierCli(evidence.args, createReceiptReader(deniedFileSystem));

    assertUnreadableDiagnostic(diagnostic, [
      evidence.receiptPath,
      "EACCES",
      "s7-eacces-should-not-echo",
    ]);
    expect(calls).toEqual({ open: 1, fstat: 0, read: 0, close: 0 });
  });

  test("requires a manifest-bound receipt length and matching all-pass publication", () => {
    const receiptOnlyEvidence = writeCliEvidence(receiptBytes());
    const receiptOnly = runStandaloneCli(["--receipt", receiptOnlyEvidence.receiptPath]);
    expect(receiptOnly.exitCode).toBe(78);
    expect(parseJsonOutput(receiptOnly.stdout)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_ARGUMENT_INVALID",
    });

    const byteCountEvidence = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(byteCountEvidence, (manifest) => {
      const artifact = manifest.s2_cost_receipt as Record<string, unknown>;
      artifact.bytes = Number(artifact.bytes) + 1;
    });
    const phaseEvidence = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(phaseEvidence, (manifest) => {
      const statuses = manifest.local_phase_status as Record<string, unknown>;
      statuses.exercise = "fail";
    });

    for (const evidence of [byteCountEvidence, phaseEvidence]) {
      const completed = runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed.stdout)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_INVALID",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("real CLI bounds files, distinguishes unreadable receipts, rejects malformed and extra keys, and never echoes input", () => {
    const regular = writeCliEvidence(receiptText());
    const oversized = writeCliEvidence(new Uint8Array(MAX_S2_COST_RECEIPT_BYTES + 1));
    const malformedContent = "{s7-raw-content-should-not-appear";
    const malformed = writeCliEvidence(malformedContent);
    const extraKeyValue = "s7-extra-key-value-should-not-appear";
    const extraKey = writeCliEvidence(
      JSON.stringify({ ...validReceipt(), unexpected: extraKeyValue }),
    );
    const missing = writeCliEvidence(receiptText(), { receipt: "missing" });
    const nonRegular = writeCliEvidence(receiptText(), { receipt: "directory" });
    const fifo = writeCliEvidence(receiptText(), { receipt: "fifo" });
    const completedRegular = runStandaloneCli(regular.args);
    const completedMissing = runStandaloneCli(missing.args);
    const completedOversized = runStandaloneCli(oversized.args);
    const completedMalformed = runStandaloneCli(malformed.args);
    const completedExtraKey = runStandaloneCli(extraKey.args);
    const completedNonRegular = runStandaloneCli(nonRegular.args);
    const completedFifo = runStandaloneCli(fifo.args);

    for (const completed of [
      completedRegular,
      completedMissing,
      completedOversized,
      completedMalformed,
      completedExtraKey,
      completedNonRegular,
      completedFifo,
    ]) {
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
    }
    expect(parseJsonOutput(completedRegular.stdout)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
      cost_model: { s2: { state: "accepted-local" } },
    });
    expect(parseJsonOutput(completedMissing.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
    });
    expect(parseJsonOutput(completedOversized.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_TOO_LARGE",
    });
    expect(parseJsonOutput(completedMalformed.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_INVALID",
    });
    expect(parseJsonOutput(completedExtraKey.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_INVALID",
    });
    expect(parseJsonOutput(completedNonRegular.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
    });
    expect(parseJsonOutput(completedFifo.stdout)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
    });

    for (const completed of [
      completedRegular,
      completedMissing,
      completedOversized,
      completedMalformed,
      completedExtraKey,
      completedNonRegular,
      completedFifo,
    ]) {
      expect(completed.stdout).not.toContain(regular.receiptPath);
      expect(completed.stdout).not.toContain(missing.receiptPath);
      expect(completed.stdout).not.toContain(oversized.receiptPath);
      expect(completed.stdout).not.toContain(malformed.receiptPath);
      expect(completed.stdout).not.toContain(extraKey.receiptPath);
      expect(completed.stdout).not.toContain(malformedContent);
      expect(completed.stdout).not.toContain(extraKeyValue);
      expect(completed.stdout).not.toContain(fifo.receiptPath);
    }
  });

  test("standalone CLI returns an honest blocked diagnostic and exit 78", () => {
    const completed = runStandaloneCli(["--receipt"]);
    expect(completed.exitCode).toBe(78);
    expect(parseJsonOutput(completed.stdout)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_ARGUMENT_INVALID",
    });
    expect(completed.stdout).not.toContain("/Users/");
  });
});
