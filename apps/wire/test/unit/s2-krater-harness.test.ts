import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { S2_COST_RECEIPT_BINDINGS_KEYS, S2_COST_RECEIPT_ROOT_KEYS } from "@asimposium/contracts";

import {
  buildS2CostMeasurementReceipt,
  S2_COST_RECEIPT_RELATIVE_PATH,
  type S2CostReceiptProvenance,
  type S2SettledWriteResult,
  writeS2CostMeasurementReceipt,
} from "../../src/krater/s2-client.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = "scripts/e2e-s2-krater.sh";
const REAL_BINDING_INTEGRATION = resolve(
  REPOSITORY_ROOT,
  "apps/wire/test/integration/s2-krater-real-bindings.test.ts",
);

const COST_PROVENANCE: S2CostReceiptProvenance = {
  run_id: "s2-cost-producer",
  revision: "a".repeat(40),
  dirty_state: "clean",
  source_digest: "b".repeat(64),
};

const COST_WRITES: readonly S2SettledWriteResult[] = [
  {
    event_id: "E-s2-001",
    seq: 1,
    idempotent: false,
    pre_cursor: 0,
    post_cursor: 1,
    payload_sha256: "1".repeat(64),
    row_digest: "2".repeat(64),
    build_digest: "3".repeat(64),
    chain_digest: "4".repeat(64),
    checkpoint_digest: "5".repeat(64),
    write_phase_ms: 1,
    successful_batch_rows_read: 3,
    successful_batch_rows_written: 2,
    successful_batch_sql_ms: 1,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 4,
    preflight_rows_written: 0,
    preflight_sql_ms: 1,
    preflight_wall_ms: 10,
    preflight_statements: 3,
    preflight_fast_path: true,
    write_claim_wall_ms: 100,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 0,
    outbox_handoff: "armed",
  },
  {
    event_id: "E-s2-002",
    seq: 2,
    idempotent: false,
    pre_cursor: 1,
    post_cursor: 2,
    payload_sha256: "6".repeat(64),
    row_digest: "7".repeat(64),
    build_digest: "8".repeat(64),
    chain_digest: "9".repeat(64),
    checkpoint_digest: "a".repeat(64),
    write_phase_ms: 20,
    successful_batch_rows_read: 5,
    successful_batch_rows_written: 4,
    successful_batch_sql_ms: 2,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 6,
    preflight_rows_written: 1,
    preflight_sql_ms: 2,
    preflight_wall_ms: 5,
    preflight_statements: 4,
    preflight_fast_path: true,
    write_claim_wall_ms: 110,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 1,
    outbox_handoff: "armed",
  },
  {
    event_id: "E-s2-003",
    seq: 3,
    idempotent: false,
    pre_cursor: 2,
    post_cursor: 3,
    payload_sha256: "b".repeat(64),
    row_digest: "c".repeat(64),
    build_digest: "d".repeat(64),
    chain_digest: "e".repeat(64),
    checkpoint_digest: "f".repeat(64),
    write_phase_ms: 9,
    successful_batch_rows_read: 7,
    successful_batch_rows_written: 6,
    successful_batch_sql_ms: 3,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    preflight_rows_read: 8,
    preflight_rows_written: 0,
    preflight_sql_ms: 3,
    preflight_wall_ms: 7,
    preflight_statements: 5,
    preflight_fast_path: true,
    write_claim_wall_ms: 90,
    write_claim_wall_scope: "writeClaim-entry-to-return",
    lock_wait_ms: null,
    retry_count: 2,
    outbox_handoff: "armed",
  },
];

const FIRST_COST_WRITE = COST_WRITES[0];
if (FIRST_COST_WRITE === undefined) {
  throw new Error("S2 cost fixture must contain at least one settled write");
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function exitBefore(
  exited: Promise<number>,
  milliseconds: number,
): Promise<number | undefined> {
  return Promise.race([exited, Bun.sleep(milliseconds).then(() => undefined)]);
}

async function runHarness(env: Record<string, string>, deadlineMs: number): Promise<Run> {
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT],
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let exitCode = await exitBefore(child.exited, deadlineMs);
  if (exitCode === undefined) {
    child.kill("SIGTERM");
    exitCode = await exitBefore(child.exited, 10_000);
  }
  if (exitCode === undefined) {
    child.kill("SIGKILL");
    exitCode = await child.exited;
  }
  const result = { exitCode, stdout: await stdout, stderr: await stderr };
  if (result.exitCode === 137 && deadlineMs > 0) {
    throw new Error(`S2 harness exceeded its bounded test deadline; stderr:\n${result.stderr}`);
  }
  return result;
}

async function probeRealBindingCapability(): Promise<Run> {
  const { S2_RUN_REAL_BINDING_INTEGRATION: _authority, ...environment } = process.env;
  const child = Bun.spawn({
    cmd: [
      "bun",
      "apps/wire/test/integration/s2-krater-real-bindings.test.ts",
      "--capability-probe",
    ],
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("S2 to S7 normalized cost receipt", () => {
  test("builds the verifier's exact receipt schema from successful settled write metrics", () => {
    const privateBodySentinel = "s2-private-body-must-not-appear";
    const metricsWithPrivateBody: readonly (
      | S2SettledWriteResult
      | (S2SettledWriteResult & { readonly privateBody: string })
    )[] = [{ ...FIRST_COST_WRITE, privateBody: privateBodySentinel }, ...COST_WRITES.slice(1)];
    const receipt = buildS2CostMeasurementReceipt(metricsWithPrivateBody, COST_PROVENANCE);

    expect(Object.keys(receipt)).toEqual([...S2_COST_RECEIPT_ROOT_KEYS]);
    expect(Object.keys(receipt.bindings)).toEqual([...S2_COST_RECEIPT_BINDINGS_KEYS]);
    expect(receipt).toMatchObject({
      run_id: COST_PROVENANCE.run_id,
      revision: COST_PROVENANCE.revision,
      dirty_state: "clean",
      source_digest: COST_PROVENANCE.source_digest,
      phase: "exercise",
      status: "pass",
      metric_scope: "selected-settled-write-receipts",
      write_receipt_count: 3,
      p95_write_phase_ms: 20,
      p95_preflight_wall_ms: 10,
      p95_write_claim_wall_ms: 110,
      sum_successful_batch_rows_read: 15,
      sum_successful_batch_rows_written: 12,
      sum_preflight_rows_read: 18,
      sum_preflight_rows_written: 1,
      sum_preflight_statements: 12,
      sum_retry_count: 3,
      known_row_total_exclusions: [
        "head-and-post-write-verification-reads-no-meta",
        "failed-retry-batches-no-meta",
      ],
    });
    // Integrity backfills have their own measured response fields. They are not
    // selected successful claim WriteResults and therefore cannot be smuggled
    // into this per-selected-write denominator or represented as a total D1 cost.
    expect(JSON.stringify(receipt)).not.toContain("backfill");
    expect(JSON.stringify(receipt)).not.toContain(privateBodySentinel);
  });

  test("refuses empty or malformed selected metrics before creating an artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-refusal-"));
    const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);

    expect(() => writeS2CostMeasurementReceipt([], COST_PROVENANCE, { root, receiptPath })).toThrow(
      "S2_COST_RECEIPT_EMPTY",
    );
    expect(existsSync(receiptPath)).toBe(false);

    const malformed = structuredClone(COST_WRITES) as S2SettledWriteResult[];
    const firstMalformed = malformed[0];
    if (firstMalformed === undefined)
      throw new Error("cloned S2 cost fixture lost its first write");
    malformed[0] = { ...firstMalformed, write_phase_ms: Number.NaN };
    expect(() =>
      writeS2CostMeasurementReceipt(malformed, COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_METRICS_INVALID");
    expect(existsSync(receiptPath)).toBe(false);

    // This is deliberately outside the production type: the refusal test proves
    // runtime validation rejects an idempotent result before writing evidence.
    const idempotent = {
      ...FIRST_COST_WRITE,
      idempotent: true,
    } as unknown as S2SettledWriteResult;
    expect(() =>
      writeS2CostMeasurementReceipt([idempotent], COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_METRICS_INVALID");
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("writes one mode-0600 regular receipt, refusing overwrite, symlink, and escaped paths", () => {
    const root = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-receipt-"));
    const receiptPath = join(root, S2_COST_RECEIPT_RELATIVE_PATH);
    const written = writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
      root,
      receiptPath,
    });
    const artifact = written.artifact;

    const stat = lstatSync(receiptPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(artifact).toMatchObject({
      relativePath: S2_COST_RECEIPT_RELATIVE_PATH,
      bytes: readFileSync(receiptPath).byteLength,
    });
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(written.receipt);

    const original = readFileSync(receiptPath, "utf8");
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, { root, receiptPath }),
    ).toThrow("S2_COST_RECEIPT_EXISTS");
    expect(readFileSync(receiptPath, "utf8")).toBe(original);

    const symlinkRoot = mkdtempSync(join(tmpdir(), "asimposium-s2-cost-symlink-"));
    const symlinkPath = join(symlinkRoot, S2_COST_RECEIPT_RELATIVE_PATH);
    symlinkSync("untrusted-target", symlinkPath);
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
        root: symlinkRoot,
        receiptPath: symlinkPath,
      }),
    ).toThrow("S2_COST_RECEIPT_SYMLINK_REFUSED");
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

    const escapedPath = join(root, "nested", S2_COST_RECEIPT_RELATIVE_PATH);
    expect(() =>
      writeS2CostMeasurementReceipt(COST_WRITES, COST_PROVENANCE, {
        root,
        receiptPath: escapedPath,
      }),
    ).toThrow("S2_COST_RECEIPT_PATH_INVALID");
    expect(existsSync(escapedPath)).toBe(false);
  });

  test("keeps receipt creation exercise-only but only publishes it after every local phase", () => {
    const client = readFileSync(
      resolve(REPOSITORY_ROOT, "apps/wire/src/krater/s2-client.ts"),
      "utf8",
    );
    const exercise = client.slice(
      client.indexOf("async function exercise():"),
      client.indexOf("async function restartVerify"),
    );
    const restartAndUpgrade = client.slice(client.indexOf("async function restartVerify"));
    expect(exercise).toContain("writeS2CostMeasurementReceipt");
    expect(exercise.indexOf("writeS2CostMeasurementReceipt")).toBeLessThan(
      exercise.lastIndexOf('status: "pass"'),
    );
    expect(exercise).toContain("selectedSettledWrite");
    expect(client).toContain("if (write.idempotent)");
    expect(restartAndUpgrade).not.toContain("writeS2CostMeasurementReceipt(");
    expect(client).toContain("if (import.meta.main)");

    const shell = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    expect(shell).toContain("scripts/verify-cost-model.ts");
    expect(shell).toContain('S2_COST_RECEIPT_RELATIVE_PATH="s2-cost-input.json"');
    expect(shell).toContain("s2_cost_receipt: costReceiptSummary");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('if [[ "${phase}" == "exercise" ]]');
    expect(shell).toContain("S2_COST_LOCAL_PHASES_COMPLETE=1");
    expect(shell).toContain("write_s2_cost_publication");
    expect(shell).toContain("write_s2_cost_publication_commit");
    const onExit = shell.slice(shell.indexOf("on_exit() {"), shell.indexOf("trap on_exit EXIT"));
    expect(onExit).toContain("write_evidence_receipt");
    expect(onExit).toContain("write_s2_cost_publication");
    expect(onExit).toContain("write_s2_cost_publication_commit");
    expect(shell.indexOf("write_s2_cost_publication()")).toBeLessThan(
      shell.indexOf("write_s2_cost_publication_commit()"),
    );
  });

  test("publishes exact supervisor cleanup scope before every normal release write", () => {
    const shell = readFileSync(resolve(REPOSITORY_ROOT, SCRIPT), "utf8");
    const start = shell.slice(
      shell.indexOf("start_pinned_supervisor() {"),
      shell.indexOf("read_child_status()"),
    );
    expect(start).toContain('persist="$3" port="$4" proof_scope="$5"');
    expect(start.indexOf("S2_MOST_RECENT_SUPERVISOR=")).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      start.indexOf("printf '%s\\n' \"${release_token}\" >&7"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(start).toContain("${persist} ${port} ${proof_scope}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('"${persist}" "${port}" "${proof_scope}"; then');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('clear_most_recent_supervisor_if_marker "${S2_SERVER_MARKER}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain('most_recent_supervisor_is_tracked "${marker}"');
    expect(shell).toContain("reap_parent_terminated_supervisor_residual");
    expect(shell).toContain("S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED");
    expect(shell).toContain("S2_PARENT_TERM_RESIDUAL_UNPROVEN");
    expect(start).toContain("pre_release_group_is_stably_pinned");
    expect(shell).toContain("pre_release_helper_is_expected_snapshot");
    expect(shell).toContain("pre_release_snapshot_line_is_expected");
    expect(shell).toContain("S2_SHELL_REGRESSION_FAILED");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
    expect(shell).toContain("${S2_GROUP_MEMBER_COUNT} -ge 1 && ${S2_GROUP_MEMBER_COUNT} -le 2");
    expect(shell).toContain("S2_PLANT_PERSISTENT_PRE_RELEASE_HELPER");
    expect(shell).toContain("S2_PERSISTENT_PRE_RELEASE_HELPER_ACCEPTED");
    expect(shell).toContain("trap '' INT TERM HUP");
    expect(shell).toContain("S2_LIFECYCLE_DEADLINE_TYPED_EXIT_FAILED");
    expect(shell).toContain("return 124");
    const publicationWriters = shell.slice(
      shell.indexOf("write_evidence_receipt() {"),
      shell.indexOf("create_evidence_subdir() {"),
    );
    expect(publicationWriters).toContain("linkSync(privateSibling, destination)");
    expect(publicationWriters).toContain("fsyncSync(directoryDescriptor)");
    expect(publicationWriters).not.toContain("renameSync(");
    expect(publicationWriters).not.toContain("unlinkSync(");
    expect(publicationWriters).not.toContain("rmSync(");
    expect(shell).toContain("S2_TERM_RESISTANT_START_FAILED");
    const termInterrupt = shell.slice(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "term-interrupt-cleanup" ]]'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts literal shell source text.
      shell.indexOf('if [[ "${mode}" == "term-resistant-release" ]]'),
    );
    expect(termInterrupt).toContain("reap_parent_terminated_supervisor_residual");
    expect(termInterrupt).toContain("S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED");
    expect(termInterrupt).toContain("assert_no_run_survivors");
  });
});

describe("registered S2 shell and lifecycle regressions", () => {
  test("the fast planted shell regressions are bounded and leave no owned group behind", async () => {
    const modes = [
      "pre-release-helper-classification",
      "release-race",
      "persistent-pre-release-helper",
      "release-interleaving",
      "term-interrupt-cleanup",
      "term-resistant-release",
      "watchdog-uncertainty",
      "watchdog-self-retire",
      "parent-loss",
      "owner-loss-uncertain",
      "unowned-refusal",
      "pinned-supervisor",
      "journal-timestamps",
      "lsof-scan-failure",
      "legacy-cleanup-failure",
      "legacy-leader-loss",
      "redaction",
      "provenance",
      "indexed-phase-status",
    ] as const;

    for (const mode of modes) {
      const run = await runHarness({ S2_SHELL_REGRESSION_TEST: mode }, 30_000);
      if (run.exitCode !== 0) {
        const codes = Array.from(
          `${run.stdout}\n${run.stderr}`.matchAll(/"code":"([A-Z][A-Z0-9_]{2,95})"/g),
          (match) => match[1],
        )
          .filter((code, index, values) => values.indexOf(code) === index)
          .slice(0, 4);
        throw new Error(
          `S2 shell regression failed: ${mode}; codes=${codes.join(",") || "NO_TYPED_CODE"}`,
        );
      }
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('"suite":"s2-krater-shell","status":"pass"');
      expect(run.stdout).toContain('"suite":"s2-krater-evidence","status":"pass"');
      if (mode === "legacy-leader-loss") {
        expect(run.stdout).toContain('"code":"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN"');
        expect(run.stdout).toContain('"action":"kill-exact-residual-group"');
      } else if (mode === "term-interrupt-cleanup") {
        expect(run.stdout).toContain(
          "term-interrupted-parent-after-term-resistant-payload-control-status-cleans-most-recent-untracked-exact-supervisor",
        );
        expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
        expect(`${run.stdout}\n${run.stderr}`).not.toContain(
          "s2-parent-term-secret-must-not-appear",
        );
      } else {
        expect(`${run.stdout}\n${run.stderr}`).not.toContain('"status":"fail"');
      }
    }
  }, 360_000);

  test("an explicit evidence run id is constrained to one safe path component", async () => {
    const run = await runHarness({ S2_RUN_ID: "../not-a-run" }, 30_000);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('"code":"S2_EVIDENCE_RUN_ID_INVALID"');
  });

  test("real-Wrangler lifecycle proof is integration-only and cannot go vacuously green", () => {
    expect(existsSync(REAL_BINDING_INTEGRATION)).toBe(true);
    const source = readFileSync(REAL_BINDING_INTEGRATION, "utf8");
    expect(source).toContain("S2_REAL_BINDING_PROOF_BLOCKED");
    expect(source).toContain("S2_WRANGLER_REQUIRED_FOR_LIFECYCLE_PROOF");
    expect(source).toContain("S2_LIFECYCLE_TEST");
    expect(source).not.toContain('throw new Error("S2_REAL_BINDING');
  });

  test("the direct real-binding capability probe emits a typed blocker before Wrangler lifecycle work", async () => {
    const run = await probeRealBindingCapability();
    expect(run.exitCode).toBe(78);
    const recordLine = run.stdout.split("\n").findLast((line) => line.startsWith("{"));
    expect(recordLine).toBeDefined();
    const record = JSON.parse(recordLine ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      tool: "bun",
      package: "apps/wire",
      suite: "s2-krater-real-bindings",
      status: "blocked",
      exit_code: 78,
      code: "S2_REAL_BINDING_PROOF_BLOCKED",
    });
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(
      "runs only with explicit integration authority",
    );
  });
});
