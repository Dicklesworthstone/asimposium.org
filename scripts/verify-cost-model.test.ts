import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildS2CostMeasurementReceipt,
  type S2CostReceiptProvenance,
  type S2SettledWriteResult,
} from "../apps/wire/src/krater/s2-client.ts";
import {
  billedRequestsForInbound,
  buildCostVerifierDiagnostic,
  COST_MODEL_PINNED_SOURCES,
  calculateFableWorkload,
  costModelSourceDiscrepancies,
  createReceiptReader,
  FABLE_WORKED_EXAMPLE,
  FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
  MAX_S2_COST_RECEIPT_BYTES,
  pinnedSourcesFullyVerified,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  type ReceiptFileSystem,
  receiptDigest,
  runCostVerifierCli,
  S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
  S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_METRIC_SCOPE,
  S2_COST_PUBLICATION_COMMIT_RECORD,
  S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH,
  S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
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
    known_row_total_exclusions: [
      REQUIRED_ROW_TOTAL_EXCLUSIONS[0],
      REQUIRED_ROW_TOTAL_EXCLUSIONS[1],
    ],
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
    dirty_state: receipt.dirty_state,
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
  readonly commitPath: string;
  readonly args: readonly string[];
}

type EvidenceArtifact = "receipt" | "manifest" | "publication" | "commit";

interface CliEvidenceOptions {
  readonly receipt?: "file" | "missing" | "directory" | "fifo";
  readonly missing?: EvidenceArtifact;
  readonly symlink?: EvidenceArtifact;
  readonly provenance?: S2CostReceiptProvenance;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCliEvidence(
  contents: string | Uint8Array,
  options: CliEvidenceOptions = {},
): CliEvidence {
  const root = mkdtempSync(join(tmpdir(), "asimposium-s7-cost-"));
  const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);
  const manifestPath = join(root, S2_COST_MANIFEST_RELATIVE_PATH);
  const publicationPath = join(root, S2_COST_PUBLICATION_RELATIVE_PATH);
  const commitPath = join(root, S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH);
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const provenance = options.provenance ?? {
    run_id: "s2-cost-fixture",
    revision: REVISION,
    dirty_state: "clean" as const,
    source_digest: SOURCE_DIGEST,
  };
  const receiptKind = options.receipt ?? "file";
  const retainedFiles = [
    { path: S2_COST_RECEIPT_RELATIVE_PATH, bytes: bytes.byteLength, kind: "file" },
  ];
  const writeArtifact = (path: string, artifact: EvidenceArtifact, body: string | Uint8Array) => {
    if (options.missing === artifact) return;
    if (options.symlink === artifact) {
      const target = join(root, `.${artifact}-symlink-target`);
      writeFileSync(target, body, { mode: 0o600 });
      symlinkSync(target, path);
      return;
    }
    writeFileSync(path, body, { mode: 0o600 });
  };
  if (receiptKind === "file") {
    writeArtifact(receiptPath, "receipt", bytes);
  } else if (receiptKind === "directory") {
    mkdirSync(receiptPath, { mode: 0o700 });
  } else if (receiptKind === "fifo") {
    const mkfifo = Bun.spawnSync({ cmd: ["mkfifo", receiptPath], stdout: "pipe", stderr: "pipe" });
    expect(mkfifo.exitCode).toBe(0);
  }
  const manifest = {
    manifest_version: S2_COST_EVIDENCE_MANIFEST_VERSION,
    ...provenance,
    exit_code: 78,
    local_phase_status: ALL_LOCAL_PHASES,
    retention: {
      retained: true,
      deletion_performed: false,
      max_bytes_per_run: 3_000_000,
      max_files_per_run: 16,
      retained_bytes_before_manifest: retainedFiles.reduce((total, file) => total + file.bytes, 0),
      retained_files_before_manifest: retainedFiles.length,
      durable_publication_reservation: {
        retained_names: S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
        reserved_bytes_upper_bound: S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
      },
    },
    s2_cost_receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    },
    files: retainedFiles,
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
  const publicationBytes = new TextEncoder().encode(JSON.stringify(publication));
  const commit = {
    schema_version: S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
    record: S2_COST_PUBLICATION_COMMIT_RECORD,
    manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: sha256(manifestBytes) },
    receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    },
    publication: {
      path: S2_COST_PUBLICATION_RELATIVE_PATH,
      digest: sha256(publicationBytes),
    },
  };
  writeArtifact(manifestPath, "manifest", manifestBytes);
  writeArtifact(publicationPath, "publication", publicationBytes);
  writeArtifact(commitPath, "commit", JSON.stringify(commit));
  return {
    root,
    receiptPath,
    manifestPath,
    publicationPath,
    commitPath,
    args: [
      "--receipt",
      receiptPath,
      "--manifest",
      manifestPath,
      "--publication",
      publicationPath,
      "--commit",
      commitPath,
    ],
  };
}

function rewriteAttestedManifest(
  evidence: CliEvidence,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const manifest = JSON.parse(readFileSync(evidence.manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const publication = JSON.parse(readFileSync(evidence.publicationPath, "utf8")) as {
    manifest: { digest: string };
  };
  publication.manifest.digest = sha256(manifestBytes);
  const publicationBytes = new TextEncoder().encode(JSON.stringify(publication));
  const commit = JSON.parse(readFileSync(evidence.commitPath, "utf8")) as {
    manifest: { digest: string };
    publication: { digest: string };
  };
  commit.manifest.digest = sha256(manifestBytes);
  commit.publication.digest = sha256(publicationBytes);
  writeFileSync(evidence.manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(evidence.publicationPath, publicationBytes, { mode: 0o600 });
  writeFileSync(evidence.commitPath, JSON.stringify(commit), { mode: 0o600 });
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
      // 10,000 / 10s sustained for 30 days, against the ~45M/mo table row.
      cursor_requests_per_30_days_at_computed_peak: 2_592_000_000,
      cursor_requests_per_30_days_at_stated_rate: 259_200_000,
      base_load_per_day: 29_600,
      fable_table_requests_per_day: 1_500_000,
      // §10.1's 1,000 Fellows at 60s across a full day: 96% of the table row.
      sizing_line_requests_per_day: 1_440_000,
      // The same population at §15's inferred four hours: 6x smaller.
      sizing_line_requests_per_day_at_worked_example_duty_cycle: 240_000,
      storm_room_per_day: 60_000,
      storm_seconds_per_day_at_computed_peak: 60,
      // No declared_burst_requests_per_day: the shape is still undeclared.
    });
    expect(verifyCostModel().source_discrepancies).toEqual([
      {
        code: "FABLE_CURSOR_RATE_MISMATCH",
        stated: 100,
        computed: 1_000,
        unit: "requests / second",
      },
      {
        code: "FABLE_TABLE_SCENARIO_MISMATCH",
        table_requests_per_day: 1_500_000,
        sizing_line_requests_per_day: 1_440_000,
        worked_example_base_load_per_day: 29_600,
        storm_room_per_day: 60_000,
        unit: "requests / day",
      },
      {
        code: "FABLE_DUTY_CYCLE_MISMATCH",
        worked_example_active_seconds: 14_400,
        sizing_line_active_seconds: 86_400,
        sizing_line_requests_per_day: 1_440_000,
        sizing_line_requests_per_day_at_worked_example_duty_cycle: 240_000,
        unit: "requests / day",
      },
      {
        code: "FABLE_BURST_SHAPE_UNDECLARED",
        computed_peak_requests_per_second: 1_000,
        required_operator_inputs: ["seconds_per_occurrence", "occurrences_per_day"],
        storm_room_per_day: 60_000,
        storm_seconds_per_day_at_computed_peak: 60,
      },
    ]);
    expect(verifyCostModel().assumptions).toEqual(FABLE_WORKED_EXAMPLE_ASSUMPTIONS);
  });

  test("the three arithmetic discrepancies are independent, not one defect reported thrice", () => {
    // Fixing the cursor slip alone leaves the table and duty-cycle defects.
    const cursorFixed = calculateFableWorkload({ ...FABLE_WORKED_EXAMPLE, lurkers: 1_000 });
    expect(cursorFixed.cursor_requests_per_second).toBe(100);
    const codes = (workload: ReturnType<typeof calculateFableWorkload>) =>
      costModelSourceDiscrepancies(workload).map((entry) => entry.code);
    expect(codes(cursorFixed)).not.toContain("FABLE_CURSOR_RATE_MISMATCH");
    expect(codes(cursorFixed)).toContain("FABLE_TABLE_SCENARIO_MISMATCH");
    expect(codes(cursorFixed)).toContain("FABLE_DUTY_CYCLE_MISMATCH");

    // Aligning the duty cycles clears only that one.
    const dutyAligned = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      sizing_line_active_seconds_per_fellow_day: 14_400,
    });
    expect(codes(dutyAligned)).not.toContain("FABLE_DUTY_CYCLE_MISMATCH");
    expect(codes(dutyAligned)).toContain("FABLE_CURSOR_RATE_MISMATCH");
  });

  test("PLANTED: a missing burst shape is refused and surfaced, never defaulted", () => {
    // Absent: reported as a named decision the operator still owes.
    const undeclared = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
    expect(undeclared.declared_burst_requests_per_day).toBeUndefined();
    const gap = costModelSourceDiscrepancies(undeclared).find(
      (entry) => entry.code === "FABLE_BURST_SHAPE_UNDECLARED",
    );
    expect(gap).toMatchObject({
      computed_peak_requests_per_second: 1_000,
      required_operator_inputs: ["seconds_per_occurrence", "occurrences_per_day"],
    });

    // Declared: computed, and the gap closes. 1,000 rps x 60s x 1/day = 60,000,
    // exactly the room available, which is the calibration the operator needs.
    const declared = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      burst: { seconds_per_occurrence: 60, occurrences_per_day: 1 },
    });
    expect(declared.declared_burst_requests_per_day).toBe(60_000);
    expect(costModelSourceDiscrepancies(declared).map((entry) => entry.code)).not.toContain(
      "FABLE_BURST_SHAPE_UNDECLARED",
    );

    // Half-declared is refused rather than completed with a default.
    for (const half of [
      { seconds_per_occurrence: 0, occurrences_per_day: 1 },
      { seconds_per_occurrence: 60, occurrences_per_day: 0 },
    ]) {
      let error: unknown;
      try {
        calculateFableWorkload({ ...FABLE_WORKED_EXAMPLE, burst: half });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "WORKLOAD_INPUT_INVALID" });
    }
  });

  test("PLANTED: suppressing every execution and D1 read does not reduce inbound billed requests", () => {
    // The exact inference Fable §15 makes — "it lands on the cheapest path" —
    // is true of CPU and D1 and false of the request line. This is the PURE
    // ARITHMETIC seam: a cache hit removes the handler run, not the inbound
    // request that is billed.
    //
    // BOUNDARY: there is no local /cursor harness in scope here, so this proves
    // the identity the model relies on, NOT a measured edge hit ratio. The two
    // measurement unknowns below stay unknown precisely because this test
    // cannot close them.
    const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
    const inboundPerDay = workload.cursor_requests_per_second * 86_400;

    for (const [label, executions, d1Rows] of [
      ["every request executes the handler", inboundPerDay, inboundPerDay * 3],
      ["half are served from cache", inboundPerDay / 2, (inboundPerDay / 2) * 3],
      ["100% cache hit: no handler run, no D1 read", 0, 0],
    ] as const) {
      const billed = billedRequestsForInbound(inboundPerDay, executions, d1Rows);
      // Invariant across all three: billing follows inbound, not work done.
      expect(billed).toBe(inboundPerDay);
      expect(billed).toBeGreaterThan(0);
      // Where execution IS suppressed, billing must visibly diverge from it —
      // that divergence is the defect §15's "cheapest path" wording hides.
      if (executions < inboundPerDay) {
        expect(billed).toBeGreaterThan(executions);
      }
      expect(label.length).toBeGreaterThan(0);
    }
    // The strongest form: zero work, full bill.
    expect(billedRequestsForInbound(inboundPerDay, 0, 0)).toBe(inboundPerDay);
    // And the seam refuses an impossible count rather than normalising it.
    let overExecuted: unknown;
    try {
      billedRequestsForInbound(10, 11, 0);
    } catch (caught) {
      overExecuted = caught;
    }
    expect(overExecuted).toMatchObject({ code: "WORKLOAD_INPUT_INVALID" });

    const result = verifyCostModel();
    expect(result.unknowns).toContain("billed_worker_requests");
    expect(result.unknowns).toContain("worker_cache_hit_billing_rate");
    expect(result.status).toBe("blocked");
  });

  test("pinned sources carry current primary text, and an unverifiable one is flagged not invented", () => {
    const result = verifyCostModel();
    expect(result.pinned_sources).toEqual(COST_MODEL_PINNED_SOURCES);
    for (const source of result.pinned_sources) {
      expect(source.url.startsWith("https://developers.cloudflare.com/")).toBe(true);
      expect(source.retrieved).toBe("2026-08-17");
      if (source.verification === "current-primary-text") {
        expect(typeof source.quote).toBe("string");
        expect((source.quote ?? "").length).toBeGreaterThan(0);
        expect(source.unverified_reason).toBeUndefined();
      } else {
        // No fabricated quote stands in for text that could not be confirmed.
        expect(source.quote).toBeUndefined();
        expect((source.unverified_reason ?? "").length).toBeGreaterThan(0);
      }
    }
    // The load-bearing billed-vs-CPU sentence is quoted, not paraphrased.
    expect(result.pinned_sources[0]?.quote).toContain(
      "billed at the same per-request rate as requests that invoke the Worker",
    );
    // One mandated URL is unverifiable, so the citation set is NOT complete and
    // the model says so rather than reporting four green sources.
    expect(result.pinned_sources_fully_verified).toBe(false);
    expect(pinnedSourcesFullyVerified()).toBe(false);
    expect(result.unknowns).toContain("mandated_source_primary_text_unverified");
    expect(result.unknowns).toContain("cpu_billing_on_cache_hit_primary_text");
    // A hypothetical all-verified set would flip the flag, so it is not a constant.
    expect(
      pinnedSourcesFullyVerified([
        {
          url: "https://x",
          retrieved: "2026-08-17",
          verification: "current-primary-text",
          quote: "q",
        },
      ]),
    ).toBe(true);
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
    const firstProducerWrite = PRODUCER_WRITES[0];
    if (firstProducerWrite === undefined)
      throw new Error("producer fixture must have a first write");
    const metricsWithPrivateBody: readonly (
      | S2SettledWriteResult
      | (S2SettledWriteResult & { readonly privateBody: string })
    )[] = [
      { ...firstProducerWrite, privateBody: privateBodySentinel },
      ...PRODUCER_WRITES.slice(1),
    ];
    const receipt = buildS2CostMeasurementReceipt(metricsWithPrivateBody, PRODUCER_PROVENANCE);
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const result = verifyCostModel(FABLE_WORKED_EXAMPLE, bytes, PRODUCER_PROVENANCE);
    const evidence = writeCliEvidence(bytes, { provenance: PRODUCER_PROVENANCE });
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
        { code: "FABLE_TABLE_SCENARIO_MISMATCH", storm_room_per_day: 60_000 },
        { code: "FABLE_DUTY_CYCLE_MISMATCH", sizing_line_requests_per_day: 1_440_000 },
        { code: "FABLE_BURST_SHAPE_UNDECLARED", computed_peak_requests_per_second: 1_000 },
      ],
      pinned_sources_fully_verified: false,
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

  test("requires a manifest-bound receipt length, all-pass publication, and final commit", () => {
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
    const reservationEvidence = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(reservationEvidence, (manifest) => {
      const retention = manifest.retention as Record<string, unknown>;
      retention.max_bytes_per_run = 1;
    });
    const commitEvidence = writeCliEvidence(receiptBytes());
    const commit = JSON.parse(readFileSync(commitEvidence.commitPath, "utf8")) as {
      receipt: { digest: string };
    };
    commit.receipt.digest = "0".repeat(64);
    writeFileSync(commitEvidence.commitPath, JSON.stringify(commit), { mode: 0o600 });

    for (const evidence of [
      byteCountEvidence,
      phaseEvidence,
      reservationEvidence,
      commitEvidence,
    ]) {
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

  test("refuses a final symlink at every four-artifact evidence boundary", () => {
    const artifacts = ["receipt", "manifest", "publication", "commit"] as const;
    for (const symlink of artifacts) {
      const evidence = writeCliEvidence(receiptBytes(), { symlink });
      const completed = runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed.stdout)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_UNREADABLE",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("refuses every incomplete receipt-manifest-publication-commit crash stage", () => {
    const artifacts = ["receipt", "manifest", "publication", "commit"] as const;
    for (const missing of artifacts) {
      const evidence = writeCliEvidence(receiptBytes(), { missing });
      const completed = runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed.stdout)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_UNREADABLE",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("refuses forged empty duplicate unsafe, and overflowed manifest inventories", () => {
    const empty = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(empty, (manifest) => {
      manifest.files = [];
    });
    const duplicate = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(duplicate, (manifest) => {
      const files = manifest.files as readonly Record<string, unknown>[];
      const first = files[0];
      if (first === undefined) throw new Error("attested fixture must inventory its receipt");
      manifest.files = [...files, first];
    });
    const unsafe = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(unsafe, (manifest) => {
      const files = manifest.files as Record<string, unknown>[];
      const first = files[0];
      if (first === undefined) throw new Error("attested fixture must inventory its receipt");
      files[0] = { ...first, path: "./manifest.json" };
    });
    const overflow = writeCliEvidence(receiptBytes());
    rewriteAttestedManifest(overflow, (manifest) => {
      const files = manifest.files as Record<string, unknown>[];
      const retention = manifest.retention as Record<string, unknown>;
      const first = files[0];
      if (first === undefined) throw new Error("attested fixture must inventory its receipt");
      files[0] = { ...first, bytes: Number.MAX_SAFE_INTEGER };
      retention.retained_bytes_before_manifest = Number.MAX_SAFE_INTEGER;
      retention.max_bytes_per_run = Number.MAX_SAFE_INTEGER;
    });

    for (const evidence of [empty, duplicate, unsafe, overflow]) {
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
