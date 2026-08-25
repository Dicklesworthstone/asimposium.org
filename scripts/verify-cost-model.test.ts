import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  costModelSourceResolutions,
  createReceiptReader,
  FABLE_WORKED_EXAMPLE,
  FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
  type FableWorkedExampleInput,
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
  writeDiagnosticLine,
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
    chain_version: 2,
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

/**
 * Never swallow the subprocess evidence.
 *
 * The previous form threw a bare "CLI did not emit JSON.", which hid the exit
 * code, the byte counts, and the bytes themselves. That turned a lost-write
 * transport defect and a genuine verifier defect into the same opaque message,
 * and the transport defect went undiagnosed because the evidence that would
 * have identified it was discarded at the moment of failure.
 *
 * Excerpts are bounded so a large diagnostic cannot flood the report, and the
 * raw text is included verbatim: the tests that must prove no path or body is
 * echoed assert over `stdout` directly, so nothing is redacted here.
 */
function parseJsonOutput(completed: StandaloneCliResult | string): unknown {
  const result: StandaloneCliResult =
    typeof completed === "string"
      ? { exitCode: null, stdout: completed, stderr: "", stdoutBytes: completed.length }
      : completed;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    const excerpt = (value: string) =>
      value.length > 400 ? `${value.slice(0, 400)}…[${value.length} chars]` : value;
    throw new Error(
      [
        "CLI did not emit parseable JSON.",
        `exitCode=${String(result.exitCode)}`,
        `stdoutBytes=${result.stdoutBytes}`,
        `stderrChars=${result.stderr.length}`,
        `parseError=${error instanceof Error ? error.message : String(error)}`,
        `stdout=${JSON.stringify(excerpt(result.stdout))}`,
        `stderr=${JSON.stringify(excerpt(result.stderr))}`,
      ].join(" "),
    );
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

/**
 * Absolute, and resolved from this file rather than from the runner's cwd.
 *
 * A bare relative entrypoint made the spawned child's identity depend on how
 * the runner itself was invoked, which is how the capture defect below stayed
 * invocation-sensitive instead of reproducible.
 */
const CLI_ENTRYPOINT = join(import.meta.dir, "verify-cost-model.ts");

/**
 * Set on the nested runner so the invocation-form test unregisters itself in
 * the child. Without it the child would re-enter this file and re-spawn.
 */
const NESTED_FORM_GUARD = "ASIMPOSIUM_S7_NESTED_FORM_CHECK";

/** Repo-relative, because the point of the test is how the path is written. */
const FOCUSED_TEST_RELATIVE_PATH = "scripts/verify-cost-model.test.ts";

/** Exact name of the single test the nested runs execute. */
const TRANSPORT_BOUNDARY_TEST_NAME =
  "PLANTED: the whole diagnostic line survives the process boundary";

interface StandaloneCliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Raw captured byte length, kept so a truncated capture is visibly distinct from an empty one. */
  readonly stdoutBytes: number;
}

/**
 * Upper bound on a single captured stream.
 *
 * The diagnostic is a few kilobytes; this is generous enough that a legitimate
 * growth never trips it and small enough that a runaway child is stopped rather
 * than accumulated. Exceeding it fails the read loudly instead of truncating,
 * because a silently clipped capture is the exact condition these tests exist
 * to detect.
 */
const CLI_CAPTURE_BYTE_CAP = 1_048_576;

/** A child that never exits must fail the test, not hang the suite. */
const CLI_DEADLINE_MS = 20_000;

/**
 * ONE pinned capture slot for this test process. Not per call.
 *
 * WHY A FILE SEAM AT ALL. Pipe capture loses the child's output entirely under
 * this workspace's runtime when the parent `bun test` is invoked with a bare
 * relative path. The observed failure is `exitCode=78, stdoutBytes=0` with the
 * child having completed a blocking write. This was measured for BOTH
 * `Bun.spawnSync` with `stdout: "pipe"` AND asynchronous `Bun.spawn` with
 * streamed pipe reads, and for parent-owned file descriptors passed as `stdout`.
 * Only a redirect performed by the child's own shell survives. The repository
 * previously masked all of this by threading a `/dev/null` positional through
 * every registered test invocation.
 *
 * WHY PINNED. An earlier repair captured into a fresh `mkdtemp` directory per
 * call, which leaked one directory and two files on EVERY invocation — 471 of
 * them had accumulated — and this repository forbids deletion, so nothing could
 * clean them up. A single fixed slot is reused instead: each call truncates the
 * two files it already owns and writes over them. Truncation is an overwrite of
 * a file this process created, never an unlink.
 *
 * RETAINED-ARTIFACT SEMANTICS, STATED PLAINLY. This leaves exactly one
 * directory containing exactly two files per test process, and those files hold
 * the LAST capture only — every earlier capture is overwritten, not archived.
 * The artifact is bounded and it is not removed on exit. The slot is
 * created once with `mkdtemp` so concurrent processes cannot share or corrupt
 * one another's slot. This is one retained directory per test process, not one
 * per CLI invocation.
 */
const CAPTURE_SLOT_ROOT = mkdtempSync(join(tmpdir(), "asimposium-s7-cli-slot-"));
const CAPTURE_STDOUT_PATH = join(CAPTURE_SLOT_ROOT, "stdout");
const CAPTURE_STDERR_PATH = join(CAPTURE_SLOT_ROOT, "stderr");

let captureSlotReady = false;
/** Strict reentrancy: the slot has one writer, so a second concurrent use is a defect. */
let captureSlotInUse = false;

function ensureCaptureSlot(): void {
  if (captureSlotReady) return;
  const root = lstatSync(CAPTURE_SLOT_ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("the pinned capture slot is not a private directory.");
  }
  captureSlotReady = true;
}

/** Truncate in place, and refuse a slot path that something replaced with a link. */
function resetSlotFile(path: string): void {
  closeSync(openSync(path, "w", 0o600));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("a pinned capture slot file is not a regular file.");
  }
  if (stat.size !== 0) {
    throw new Error("a pinned capture slot file was not truncated before reuse.");
  }
}

/** Read one slot file under the byte cap; oversize fails loudly instead of clipping. */
function readSlotFile(
  path: string,
  label: string,
): { readonly text: string; readonly bytes: number } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`the ${label} capture slot is not a regular file.`);
  }
  if (stat.size > CLI_CAPTURE_BYTE_CAP) {
    throw new Error(`${label} exceeded the ${CLI_CAPTURE_BYTE_CAP}-byte capture cap.`);
  }
  const buffer = readFileSync(path);
  return { text: new TextDecoder().decode(buffer), bytes: buffer.byteLength };
}

/**
 * Run one child with its output redirected by its own shell into the pinned
 * slot, then read the slot back.
 *
 * Paths travel in the environment and the command travels as `"$0" "$@"`, so no
 * path or argument is ever re-parsed as shell syntax.
 */
async function runCapturedProcess(
  cmd: readonly string[],
  options: { readonly env?: Record<string, string>; readonly deadlineMs?: number } = {},
): Promise<StandaloneCliResult> {
  const [command, ...rest] = cmd;
  if (command === undefined) throw new Error("a captured process needs a command.");
  ensureCaptureSlot();
  if (captureSlotInUse) {
    throw new Error("the pinned capture slot is already in use; captures must not overlap.");
  }
  captureSlotInUse = true;
  try {
    resetSlotFile(CAPTURE_STDOUT_PATH);
    resetSlotFile(CAPTURE_STDERR_PATH);
    const completed = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-c",
        'exec "$0" "$@" > "$ASIMPOSIUM_S7_STDOUT" 2> "$ASIMPOSIUM_S7_STDERR"',
        command,
        ...rest,
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        ASIMPOSIUM_S7_STDOUT: CAPTURE_STDOUT_PATH,
        ASIMPOSIUM_S7_STDERR: CAPTURE_STDERR_PATH,
      },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      timeout: options.deadlineMs ?? CLI_DEADLINE_MS,
    });
    const stdout = readSlotFile(CAPTURE_STDOUT_PATH, "stdout");
    const stderr = readSlotFile(CAPTURE_STDERR_PATH, "stderr");
    return {
      exitCode: completed.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
    };
  } finally {
    captureSlotInUse = false;
  }
}

/** The consumer half of the transport boundary, over the pinned slot above. */
async function runStandaloneCli(args: readonly string[]): Promise<StandaloneCliResult> {
  return runCapturedProcess([process.execPath, CLI_ENTRYPOINT, ...args]);
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
  /**
   * The scenario as it stood before the 2026-08-17 corrections: the 10x
   * cursor slip still in the text and no operator affordability decision.
   * The independence and refusal tests run against it because the corrected
   * default no longer raises those findings — which is the point of the fix.
   */
  const FABLE_WORKED_EXAMPLE_PRE_DECISION: FableWorkedExampleInput = (() => {
    const { operator_ceiling: _omitted, ...rest } = FABLE_WORKED_EXAMPLE;
    return { ...rest, fable_stated_cursor_requests_per_second: 100 };
  })();

  test("reproduces the derived worked-example arithmetic and records the ceiling reconciliation", () => {
    expect(calculateFableWorkload(FABLE_WORKED_EXAMPLE)).toEqual({
      problems: 20,
      pack_reads_per_day: 19_200,
      workshop_pushes_per_day: 9_600,
      promotions_per_day: 800,
      cursor_requests_per_second: 1_000,
      // §15 was corrected 2026-08-17 to state the rate its cadence produces.
      fable_stated_cursor_requests_per_second: 1_000,
      // 10,000 / 10s sustained for 30 days, against the ~45M/mo table row.
      cursor_requests_per_30_days_at_computed_peak: 2_592_000_000,
      cursor_requests_per_30_days_at_stated_rate: 2_592_000_000,
      // EXACT: 19,200 + 9,600 + 800. This is the worked-example base load.
      base_load_per_day: 29_600,
      // The sum of Fable's ROUNDED display values: 19,000 + 10,000 + 800. The
      // bead's acceptance criterion states this as the base load; it is not.
      fable_displayed_base_load_per_day: 29_800,
      fable_displayed_pack_reads_per_day: 19_000,
      fable_displayed_workshop_pushes_per_day: 10_000,
      fable_displayed_promotions_per_day: 800,
      fable_table_requests_per_day: 1_500_000,
      // §10.1's 1,000 Fellows at 60s across a full day: 96% of the table row.
      sizing_line_requests_per_day: 1_440_000,
      // The same population at §15's inferred four hours: 6x smaller.
      sizing_line_requests_per_day_at_worked_example_duty_cycle: 240_000,
      sizing_line_enumerated_request_classes: ["pack_reads"],
      sizing_line_unenumerated_request_classes: [
        "workshop_pushes",
        "promotions",
        "cursor_polls",
        "session_opens_and_closes",
        "promotion_validation_reads",
        "public_face_reads",
      ],
      worked_example_active_seconds_per_fellow_day: 14_400,
      sizing_line_active_seconds_per_fellow_day: 86_400,
      // The operator-ceiling reconciliation: a fully sustained peak month at
      // the pinned 2026-08-17 pricing. 2,582M excess requests × $0.30/M +
      // 2,562M excess CPU-ms × $0.02/M + $5 base = $830.84.
      sustained_peak_monthly_cost_usd: 830.84,
      operator_ceiling_usd_per_month: 1_000,
      operator_ceiling_accepted_on: "2026-08-17",
      operator_ceiling_pricing_retrieved_on: "2026-08-17",
      // No storm_room_per_day and no storm_seconds_per_day_at_computed_peak:
      // neither is established, so neither is reported as a number.
      // No declared_burst_requests_per_day: the operator resolved
      // affordability with the ceiling, so the shape stays undeclared.
    });
    expect(verifyCostModel().source_discrepancies).toEqual([
      {
        code: "FABLE_TABLE_SCENARIO_MISMATCH",
        table_requests_per_day: 1_500_000,
        sizing_line_requests_per_day: 1_440_000,
        worked_example_base_load_per_day: 29_600,
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
        code: "FABLE_STORM_ROOM_UNRESOLVED",
        table_requests_per_day: 1_500_000,
        sizing_line_requests_per_day: 1_440_000,
        enumerated_request_classes: ["pack_reads"],
        unenumerated_request_classes: [
          "workshop_pushes",
          "promotions",
          "cursor_polls",
          "session_opens_and_closes",
          "promotion_validation_reads",
          "public_face_reads",
        ],
        reason:
          "The ~45M/mo row is a 1,000-Fellow sizing line that enumerates pack reads only, so subtracting it from the row does not yield storm room. No storm-room, burst-duration, or headroom figure is established until an operator supplies an internally complete scenario.",
        required_operator_inputs: ["accepted_scenario_with_complete_request_class_enumeration"],
      },
      {
        code: "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH",
        exact_base_load_per_day: 29_600,
        rounded_display_sum_per_day: 29_800,
        difference_per_day: 200,
        exact_components: {
          pack_reads_per_day: 19_200,
          workshop_pushes_per_day: 9_600,
          promotions_per_day: 800,
        },
        rounded_display_components: {
          pack_reads_per_day: 19_000,
          workshop_pushes_per_day: 10_000,
          promotions_per_day: 800,
        },
        authority: "exact_components",
        unit: "requests / day",
      },
    ]);
    expect(verifyCostModel().source_resolutions).toEqual([
      {
        code: "OPERATOR_CEILING_COVERS_SUSTAINED_PEAK",
        ceiling_usd_per_month: 1_000,
        sustained_peak_monthly_cost_usd: 830.84,
        accepted_on: "2026-08-17",
        pricing_retrieved_on: "2026-08-17",
        unit: "usd / month",
      },
    ]);
    expect(verifyCostModel().assumptions).toEqual(FABLE_WORKED_EXAMPLE_ASSUMPTIONS);
  });

  test("PLANTED: 29,600 is exact and 29,800 is never encoded as the exact base load", () => {
    const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
    // The worked-input result, asserted component-by-component and as a sum.
    expect(workload.pack_reads_per_day).toBe(19_200);
    expect(workload.workshop_pushes_per_day).toBe(9_600);
    expect(workload.promotions_per_day).toBe(800);
    expect(
      workload.pack_reads_per_day + workload.workshop_pushes_per_day + workload.promotions_per_day,
    ).toBe(29_600);
    expect(workload.base_load_per_day).toBe(29_600);

    // The bead's figure is present ONLY as a labelled sum of rounded display
    // values, and is never the field any consumer reads as the base load.
    expect(workload.fable_displayed_base_load_per_day).toBe(29_800);
    expect(workload.base_load_per_day).not.toBe(workload.fable_displayed_base_load_per_day);

    const gap = costModelSourceDiscrepancies(workload).find(
      (entry) => entry.code === "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH",
    );
    expect(gap).toMatchObject({
      exact_base_load_per_day: 29_600,
      rounded_display_sum_per_day: 29_800,
      difference_per_day: 200,
      authority: "exact_components",
    });

    // Anti-vacuity: the mismatch is detected, not hard-coded. A scenario whose
    // displayed values happen to be exact clears it and nothing else.
    const exactlyDisplayed = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      fable_displayed_pack_reads_per_day: 19_200,
      fable_displayed_workshop_pushes_per_day: 9_600,
    });
    expect(exactlyDisplayed.fable_displayed_base_load_per_day).toBe(29_600);
    const clearedCodes = costModelSourceDiscrepancies(exactlyDisplayed).map((entry) => entry.code);
    expect(clearedCodes).not.toContain("FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH");
    expect(clearedCodes).toContain("FABLE_STORM_ROOM_UNRESOLVED");
  });

  test("PLANTED: neither 60,000/day nor 1,470,200/day is published as storm room", () => {
    const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
    const result = verifyCostModel();
    const serialized = JSON.stringify({ workload, result });

    // Both candidates are arithmetically derivable from figures the verifier
    // does report, and neither may appear as an established quantity.
    expect(workload.fable_table_requests_per_day - workload.sizing_line_requests_per_day).toBe(
      60_000,
    );
    // The bead's 1,470,200 is 1,500,000 - 29,800, so it is computed from the
    // ROUNDED display sum and inherits that error. Subtracting the exact base
    // load gives 1,470,400 instead. Recorded because it shows the rounding
    // defect propagating into the very figure that was offered as the
    // reconciliation — a further reason neither number is adopted.
    expect(workload.fable_table_requests_per_day - workload.fable_displayed_base_load_per_day).toBe(
      1_470_200,
    );
    expect(workload.fable_table_requests_per_day - workload.base_load_per_day).toBe(1_470_400);
    expect(serialized).not.toContain("60000");
    expect(serialized).not.toContain("1470200");
    expect(serialized).not.toContain("1470400");
    expect(serialized).not.toContain('storm_room_per_day":');
    expect(serialized).not.toContain("storm_seconds_per_day");
    expect(Object.keys(workload)).not.toContain("storm_room_per_day");
    expect(Object.keys(workload)).not.toContain("storm_seconds_per_day_at_computed_peak");

    // The withheld quantities are named as unknowns rather than silently absent.
    expect(result.unknowns).toContain("storm_room_per_day");
    expect(result.unknowns).toContain("burst_duration_and_frequency");
    expect(result.unknowns).toContain("monthly_request_headroom");

    // And the reason is reported, with the incomplete enumeration that causes it.
    const unresolved = result.source_discrepancies.find(
      (entry) => entry.code === "FABLE_STORM_ROOM_UNRESOLVED",
    );
    expect(unresolved).toMatchObject({
      enumerated_request_classes: ["pack_reads"],
      required_operator_inputs: ["accepted_scenario_with_complete_request_class_enumeration"],
    });
    if (unresolved === undefined || unresolved.code !== "FABLE_STORM_ROOM_UNRESOLVED") {
      throw new Error("the storm-room decision must be reported as outstanding");
    }
    expect(unresolved.unenumerated_request_classes.length).toBeGreaterThan(0);

    // The exact sustained arithmetic the bead does establish stays exact.
    expect(workload.cursor_requests_per_second).toBe(1_000);
    expect(workload.cursor_requests_per_30_days_at_computed_peak).toBe(2_592_000_000);
  });

  test("every discrepancy clears independently, so none is a restatement of another", () => {
    const codes = (input: Parameters<typeof calculateFableWorkload>[0]) =>
      costModelSourceDiscrepancies(calculateFableWorkload(input)).map((entry) => entry.code);

    const ALL = [
      "FABLE_CURSOR_RATE_MISMATCH",
      "FABLE_TABLE_SCENARIO_MISMATCH",
      "FABLE_DUTY_CYCLE_MISMATCH",
      "FABLE_BURST_SHAPE_UNDECLARED",
      "FABLE_STORM_ROOM_UNRESOLVED",
      "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH",
    ] as const;

    // The pre-decision scenario raises all six. The corrected default no
    // longer raises the two the operator's decisions closed — which is what
    // the first test asserts — so the independence proof runs here.
    expect(codes(FABLE_WORKED_EXAMPLE_PRE_DECISION).sort()).toEqual([...ALL].sort());

    // Each entry is the single input change that closes exactly one of them.
    const repairs: Array<
      readonly [(typeof ALL)[number], Partial<Parameters<typeof calculateFableWorkload>[0]>]
    > = [
      // 1,000 lurkers / 10s == the 100 rps §15 prints.
      ["FABLE_CURSOR_RATE_MISMATCH", { lurkers: 1_000 }],
      // A table row that states the worked example's own base load.
      ["FABLE_TABLE_SCENARIO_MISMATCH", { fable_table_requests_per_month: 29_600 * 30 }],
      // One duty cycle for both scenarios.
      ["FABLE_DUTY_CYCLE_MISMATCH", { sizing_line_active_seconds_per_fellow_day: 14_400 }],
      // An operator-accepted burst shape.
      [
        "FABLE_BURST_SHAPE_UNDECLARED",
        { burst: { seconds_per_occurrence: 60, occurrences_per_day: 1 } },
      ],
      // A scenario that accounts for every request class it generates.
      ["FABLE_STORM_ROOM_UNRESOLVED", { sizing_line_unenumerated_request_classes: [] }],
      // Display values that are not rounded away from the exact cadences.
      [
        "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH",
        {
          fable_displayed_pack_reads_per_day: 19_200,
          fable_displayed_workshop_pushes_per_day: 9_600,
        },
      ],
    ];

    for (const [cleared, repair] of repairs) {
      const remaining = codes({ ...FABLE_WORKED_EXAMPLE_PRE_DECISION, ...repair });
      // The targeted defect is gone...
      expect(remaining).not.toContain(cleared);
      // ...and every other one survives untouched. A code that vanished here
      // would mean two records were really one defect counted twice.
      for (const other of ALL) {
        if (other === cleared) continue;
        expect(remaining).toContain(other);
      }
      expect(remaining).toHaveLength(ALL.length - 1);
    }
  });

  test("PLANTED: discrepancies are computed from the given workload, never the module default", () => {
    // A scenario that differs from FABLE_WORKED_EXAMPLE in exactly the fields the
    // detector reports. If any branch reached for the default constant instead of
    // its argument, it would report 14,400/86,400 and 100 rps here.
    const alternate = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      active_seconds_per_fellow_day: 7_200,
      sizing_line_active_seconds_per_fellow_day: 43_200,
      fable_stated_cursor_requests_per_second: 250,
      lurkers: 20_000,
    });

    const duty = costModelSourceDiscrepancies(alternate).find(
      (entry) => entry.code === "FABLE_DUTY_CYCLE_MISMATCH",
    );
    expect(duty).toMatchObject({
      worked_example_active_seconds: 7_200,
      sizing_line_active_seconds: 43_200,
    });
    // Explicitly NOT the module default's values.
    expect(duty).not.toMatchObject({ worked_example_active_seconds: 14_400 });
    expect(duty).not.toMatchObject({ sizing_line_active_seconds: 86_400 });

    const cursor = costModelSourceDiscrepancies(alternate).find(
      (entry) => entry.code === "FABLE_CURSOR_RATE_MISMATCH",
    );
    // Stated rate comes from the supplied scenario, not a hard-coded 100.
    expect(cursor).toMatchObject({ stated: 250, computed: 2_000 });
    expect(alternate.cursor_requests_per_30_days_at_stated_rate).toBe(250 * 86_400 * 30);
  });

  test("PLANTED: a missing burst shape is refused and surfaced, never defaulted", () => {
    // Absent, with no affordability alternative standing: reported as a named
    // decision the operator still owes. (The corrected default carries the
    // operator ceiling, which covers this; the ceiling behavior has its own
    // test below.)
    const undeclared = calculateFableWorkload(FABLE_WORKED_EXAMPLE_PRE_DECISION);
    expect(undeclared.declared_burst_requests_per_day).toBeUndefined();
    const gap = costModelSourceDiscrepancies(undeclared).find(
      (entry) => entry.code === "FABLE_BURST_SHAPE_UNDECLARED",
    );
    expect(gap).toMatchObject({
      computed_peak_requests_per_second: 1_000,
      required_operator_inputs: ["seconds_per_occurrence", "occurrences_per_day"],
    });

    // Declared: the burst's OWN volume is computed exactly, and that gap closes.
    // 1,000 rps x 60 s x 1/day = 60,000 requests/day of burst traffic. This is
    // not compared to any headroom, and the storm-room decision stays open:
    // knowing what a burst costs is not knowing what the budget can absorb.
    const declared = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      burst: { seconds_per_occurrence: 60, occurrences_per_day: 1 },
    });
    expect(declared.declared_burst_requests_per_day).toBe(60_000);
    const declaredCodes = costModelSourceDiscrepancies(declared).map((entry) => entry.code);
    expect(declaredCodes).not.toContain("FABLE_BURST_SHAPE_UNDECLARED");
    expect(declaredCodes).toContain("FABLE_STORM_ROOM_UNRESOLVED");

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

  test("operator ceiling reconciliation: covers, exceeds, or stays open", () => {
    // Covers (the corrected default): no burst demand, no exceedance, and the
    // resolution record carries the exact sustained cost and decision dates.
    const covered = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
    expect(covered.sustained_peak_monthly_cost_usd).toBe(830.84);
    const coveredCodes = costModelSourceDiscrepancies(covered).map((entry) => entry.code);
    expect(coveredCodes).not.toContain("FABLE_BURST_SHAPE_UNDECLARED");
    expect(coveredCodes).not.toContain("FABLE_OPERATOR_CEILING_EXCEEDED");
    expect(costModelSourceResolutions(covered)).toEqual([
      {
        code: "OPERATOR_CEILING_COVERS_SUSTAINED_PEAK",
        ceiling_usd_per_month: 1_000,
        sustained_peak_monthly_cost_usd: 830.84,
        accepted_on: "2026-08-17",
        pricing_retrieved_on: "2026-08-17",
        unit: "usd / month",
      },
    ]);

    // Exceeded: a ceiling below the sustained cost raises the exceedance AND
    // keeps the burst-shape demand — a too-low ceiling is not a resolution.
    const defaultCeiling = FABLE_WORKED_EXAMPLE.operator_ceiling;
    if (defaultCeiling === undefined) throw new Error("the default declares the operator ceiling");
    const exceeded = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      operator_ceiling: {
        ...defaultCeiling,
        usd_per_month: 100,
      },
    });
    const exceededCodes = costModelSourceDiscrepancies(exceeded).map((entry) => entry.code);
    expect(exceededCodes).toContain("FABLE_OPERATOR_CEILING_EXCEEDED");
    expect(exceededCodes).toContain("FABLE_BURST_SHAPE_UNDECLARED");
    expect(costModelSourceResolutions(exceeded)).toEqual([]);
    const exceedance = costModelSourceDiscrepancies(exceeded).find(
      (entry) => entry.code === "FABLE_OPERATOR_CEILING_EXCEEDED",
    );
    expect(exceedance).toMatchObject({
      ceiling_usd_per_month: 100,
      sustained_peak_monthly_cost_usd: 830.84,
    });

    // Undeclared: the pre-decision state owes the burst shape and records no
    // resolution.
    expect(
      costModelSourceResolutions(calculateFableWorkload(FABLE_WORKED_EXAMPLE_PRE_DECISION)),
    ).toEqual([]);

    // Anti-vacuity: the sustained cost is computed from the declared pricing,
    // not hard-coded. Doubling the request price doubles the request line:
    // 2,582M × $0.60/M + 2,562M × $0.02/M + $5 = $1,605.44, over the ceiling.
    const repriced = calculateFableWorkload({
      ...FABLE_WORKED_EXAMPLE,
      operator_ceiling: {
        ...defaultCeiling,
        pricing: {
          ...defaultCeiling.pricing,
          request_usd_per_million: 0.6,
        },
      },
    });
    expect(repriced.sustained_peak_monthly_cost_usd).toBe(1605.44);
    expect(costModelSourceDiscrepancies(repriced).map((entry) => entry.code)).toContain(
      "FABLE_OPERATOR_CEILING_EXCEEDED",
    );
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

    // (a) Hold inbound FIXED and sweep execution and D1 all the way to zero.
    // Billing must not move at all.
    const billedAtFixedInbound = new Set<number>();
    for (const [label, executions, d1Rows] of [
      ["every request executes the handler", inboundPerDay, inboundPerDay * 3],
      ["half are served from cache", inboundPerDay / 2, (inboundPerDay / 2) * 3],
      ["a tenth execute", inboundPerDay / 10, 0],
      ["100% cache hit: no handler run, no D1 read", 0, 0],
    ] as const) {
      const billed = billedRequestsForInbound(inboundPerDay, executions, d1Rows);
      billedAtFixedInbound.add(billed);
      expect(billed).toBe(inboundPerDay);
      expect(billed).toBeGreaterThan(0);
      // Where execution IS suppressed, billing must visibly diverge from it —
      // that divergence is the defect §15's "cheapest path" wording hides.
      if (executions < inboundPerDay) {
        expect(billed).toBeGreaterThan(executions);
      }
      expect(label.length).toBeGreaterThan(0);
    }
    // Four different work profiles, exactly one billed figure.
    expect(billedAtFixedInbound.size).toBe(1);

    // (b) The converse, which is what makes this an identity rather than a
    // constant: hold execution and D1 FIXED at zero — the fully-cached case —
    // and vary inbound. Billing must track inbound one-for-one. Without this
    // direction the assertion above is also satisfied by a function that
    // ignores its inputs entirely.
    const cachedOnly = [1, 1_000, inboundPerDay, inboundPerDay * 7] as const;
    for (const inbound of cachedOnly) {
      expect(billedRequestsForInbound(inbound, 0, 0)).toBe(inbound);
    }
    expect(new Set(cachedOnly.map((n) => billedRequestsForInbound(n, 0, 0))).size).toBe(
      cachedOnly.length,
    );
    // Doubling inbound doubles the bill while the work stays at zero.
    expect(billedRequestsForInbound(inboundPerDay * 2, 0, 0)).toBe(
      billedRequestsForInbound(inboundPerDay, 0, 0) * 2,
    );

    // (c) And D1 reads move independently of both: same inbound, same
    // executions, wildly different row counts, identical bill.
    expect(billedRequestsForInbound(inboundPerDay, 10, 0)).toBe(
      billedRequestsForInbound(inboundPerDay, 10, 5_000_000),
    );
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

  test("accepts the normalized S2 producer receipt but preserves the terminal exit-78 boundary", async () => {
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
    const cli = await runStandaloneCli(evidence.args);

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
        { code: "FABLE_TABLE_SCENARIO_MISMATCH", worked_example_base_load_per_day: 29_600 },
        { code: "FABLE_DUTY_CYCLE_MISMATCH", sizing_line_requests_per_day: 1_440_000 },
        { code: "FABLE_STORM_ROOM_UNRESOLVED", enumerated_request_classes: ["pack_reads"] },
        { code: "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH", rounded_display_sum_per_day: 29_800 },
      ],
      source_resolutions: [
        {
          code: "OPERATOR_CEILING_COVERS_SUSTAINED_PEAK",
          ceiling_usd_per_month: 1_000,
          sustained_peak_monthly_cost_usd: 830.84,
        },
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
    expect(parseJsonOutput(cli)).toMatchObject({
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

  test("requires a manifest-bound receipt length, all-pass publication, and final commit", async () => {
    const receiptOnlyEvidence = writeCliEvidence(receiptBytes());
    const receiptOnly = await runStandaloneCli(["--receipt", receiptOnlyEvidence.receiptPath]);
    expect(receiptOnly.exitCode).toBe(78);
    expect(parseJsonOutput(receiptOnly)).toMatchObject({
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
      const completed = await runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_INVALID",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("refuses a final symlink at every four-artifact evidence boundary", async () => {
    const artifacts = ["receipt", "manifest", "publication", "commit"] as const;
    for (const symlink of artifacts) {
      const evidence = writeCliEvidence(receiptBytes(), { symlink });
      const completed = await runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_UNREADABLE",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("refuses every incomplete receipt-manifest-publication-commit crash stage", async () => {
    const artifacts = ["receipt", "manifest", "publication", "commit"] as const;
    for (const missing of artifacts) {
      const evidence = writeCliEvidence(receiptBytes(), { missing });
      const completed = await runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_UNREADABLE",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("refuses forged empty duplicate unsafe, and overflowed manifest inventories", async () => {
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
      const completed = await runStandaloneCli(evidence.args);
      expect(completed.exitCode).toBe(78);
      expect(completed.stderr).toBe("");
      expect(parseJsonOutput(completed)).toMatchObject({
        status: "blocked",
        code: "S2_COST_RECEIPT_INVALID",
      });
      expect(completed.stdout).not.toContain(evidence.root);
    }
  });

  test("real CLI bounds files, distinguishes unreadable receipts, rejects malformed and extra keys, and never echoes input", async () => {
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
    const completedRegular = await runStandaloneCli(regular.args);
    const completedMissing = await runStandaloneCli(missing.args);
    const completedOversized = await runStandaloneCli(oversized.args);
    const completedMalformed = await runStandaloneCli(malformed.args);
    const completedExtraKey = await runStandaloneCli(extraKey.args);
    const completedNonRegular = await runStandaloneCli(nonRegular.args);
    const completedFifo = await runStandaloneCli(fifo.args);

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
    expect(parseJsonOutput(completedRegular)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
      cost_model: { s2: { state: "accepted-local" } },
    });
    expect(parseJsonOutput(completedMissing)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
    });
    expect(parseJsonOutput(completedOversized)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_TOO_LARGE",
    });
    expect(parseJsonOutput(completedMalformed)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_INVALID",
    });
    expect(parseJsonOutput(completedExtraKey)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_INVALID",
    });
    expect(parseJsonOutput(completedNonRegular)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_UNREADABLE",
    });
    expect(parseJsonOutput(completedFifo)).toMatchObject({
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

  test("PLANTED: the whole diagnostic line survives the process boundary", async () => {
    // The defect this guards: the CLI exits 78 while its stdout arrives empty or
    // truncated, which reads as a verifier failure but is a lost write. The
    // producer now writes fd 1 to completion before setting an exit code, and
    // the harness captures through a shell redirect rather than the runner's
    // stdio plumbing. Both halves are asserted here on the real subprocess.
    const evidence = writeCliEvidence(receiptBytes());
    const completed = await runStandaloneCli(evidence.args);

    // Byte-level, not just parseable: a truncated line can still parse if the
    // truncation lands after a closing brace, so length and framing are checked.
    expect(completed.exitCode).toBe(78);
    expect(completed.stdoutBytes).toBeGreaterThan(1_000);
    expect(completed.stdout.endsWith("}\n")).toBe(true);
    expect(completed.stdout.split("\n").filter((line) => line !== "")).toHaveLength(1);
    expect(new TextEncoder().encode(completed.stdout).byteLength).toBe(completed.stdoutBytes);

    // The captured bytes are the complete diagnostic, not a prefix of one.
    const parsed = parseJsonOutput(completed) as { cost_model?: { unknowns?: unknown } };
    expect(parsed.cost_model?.unknowns).toBeDefined();
    expect(JSON.stringify(parsed).length).toBeGreaterThan(1_000);

    // Repeated runs deliver the identical byte count: a capture that drops
    // output does so intermittently, so a single success proves little.
    const repeats = [
      await runStandaloneCli(evidence.args),
      await runStandaloneCli(evidence.args),
      await runStandaloneCli(evidence.args),
    ];
    for (const repeat of repeats) {
      expect(repeat.exitCode).toBe(78);
      expect(repeat.stdoutBytes).toBe(completed.stdoutBytes);
      expect(repeat.stderr).toBe("");
    }

    // Anti-vacuity: the capture reflects THIS child's output rather than a
    // constant. A different argument list must come back with a different
    // diagnostic code and a different byte count, which a helper returning
    // canned bytes could not produce.
    const other = await runStandaloneCli(["--receipt", "/nonexistent", "--manifest"]);
    expect(other.exitCode).toBe(78);
    expect(other.stderr).toBe("");
    const otherParsed = parseJsonOutput(other) as { code?: string };
    expect(otherParsed.code).toBe("COST_MODEL_ARGUMENT_INVALID");
    expect(parsed).toMatchObject({ code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE" });
    expect(other.stdoutBytes).not.toBe(completed.stdoutBytes);
  });

  test("PLANTED: diagnostic publication waits for the writer completion callback", async () => {
    const line = '{"status":"blocked"}\n';
    let writtenLine: string | undefined;
    let completeWrite: ((error?: Error | null) => void) | undefined;
    let settled = false;

    const pending = writeDiagnosticLine(line, 1_000, (candidate, callback) => {
      writtenLine = candidate;
      completeWrite = callback;
    });
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(writtenLine).toBe(line);
    expect(completeWrite).toBeFunction();
    expect(settled).toBe(false);

    completeWrite?.();
    expect(await pending).toBe(Buffer.byteLength(line, "utf8"));
    expect(settled).toBe(true);
  });

  test("PLANTED: a writer that never completes is refused within the fixed deadline", async () => {
    const startedAt = performance.now();
    const pending = writeDiagnosticLine("blocked\n", 25, () => {});

    await expect(pending).rejects.toMatchObject({
      code: "COST_MODEL_DIAGNOSTIC_WRITE_FAILED",
    });
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("standalone CLI returns an honest blocked diagnostic and exit 78", async () => {
    const completed = await runStandaloneCli(["--receipt"]);
    expect(completed.exitCode).toBe(78);
    expect(parseJsonOutput(completed)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_ARGUMENT_INVALID",
    });
    expect(completed.stdout).not.toContain("/Users/");
  });

  // The capture defect was invisible to this suite for as long as every
  // registered invocation carried a `/dev/null` positional, because the failure
  // depends on HOW the parent runner was invoked rather than on anything the
  // tests do. A suite that only ever runs one way cannot notice that. So the
  // file re-runs itself under each form and requires all of them to pass.
  //
  // Recursion is prevented twice over: the nested child is given the guard
  // variable, which unregisters this test entirely, and it is additionally
  // narrowed with an exact `-t` name filter that this test's own name does not
  // match. Either alone would stop it; both are cheap.
  if (process.env[NESTED_FORM_GUARD] !== "1") {
    test("PLANTED: the focused file passes under bare, ./, and /dev/null parent forms", async () => {
      const forms: ReadonlyArray<readonly [string, readonly string[]]> = [
        // The form that reproduced the defect.
        ["bare relative", ["test", FOCUSED_TEST_RELATIVE_PATH]],
        ["dot relative", ["test", `./${FOCUSED_TEST_RELATIVE_PATH}`]],
        // The historical crutch form, kept so a regression that only survives
        // WITH the filter is still visible as a difference between the forms.
        ["dev-null filter", ["test", "/dev/null", "--timeout=120000", FOCUSED_TEST_RELATIVE_PATH]],
      ];

      for (const [label, testArgs] of forms) {
        const nested = await runCapturedProcess(
          [process.execPath, ...testArgs, "-t", TRANSPORT_BOUNDARY_TEST_NAME],
          { env: { [NESTED_FORM_GUARD]: "1" }, deadlineMs: 120_000 },
        );
        const evidence = `${label}: exit=${String(nested.exitCode)} stdout=${nested.stdout.slice(-400)} stderr=${nested.stderr.slice(-400)}`;
        // bun test exits non-zero on any failure, so the exit code is the verdict.
        expect(evidence.length).toBeGreaterThan(0);
        expect({ label, exitCode: nested.exitCode }).toEqual({ label, exitCode: 0 });
        // Anti-vacuity: a run that matched nothing also exits 0, so require that
        // the nested runner actually executed the target test.
        expect(`${nested.stdout}${nested.stderr}`).toContain("1 pass");
        expect(`${nested.stdout}${nested.stderr}`).not.toContain("0 pass");
      }
      // Three full nested runner startups; the default per-test deadline is far
      // too short for that, and inheriting it would report a slow machine as a
      // transport regression.
    }, 300_000);
  }
});
