import { expect, test } from "bun:test";

import { generatedArtifacts } from "../../src/artifacts.ts";
import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import { ContractScaffoldSchema } from "../../src/schema.ts";
import {
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
  S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_PUBLICATION_COMMIT_RECORD,
  S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_RECEIPT_BINDINGS_KEYS,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_ROOT_KEYS,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2CostEvidenceManifestSchema,
  S2CostMeasurementReceiptSchema,
  S2CostReceiptPublicationCommitSchema,
} from "../../src/s2-cost-receipt.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/contracts-scaffold.json", import.meta.url);
const INVALID_FIXTURE = new URL(
  "../fixtures/invalid/contracts-scaffold-stale.json",
  import.meta.url,
);

function failureDiagnostic(suite: string, startedAt: number, code: DiagnosticCode): string {
  return safeDiagnostic({
    suite,
    status: "invalid",
    startedAt,
    code,
    reproduce: REPRODUCE.unit,
  });
}

async function readFixture(url: URL, suite: string): Promise<unknown> {
  const startedAt = performance.now();
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error(failureDiagnostic(suite, startedAt, "FIXTURE_JSON_INVALID"));
  }
}

test("valid scaffold fixture parses through the Zod source of truth", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(VALID_FIXTURE, "schema.valid-fixture"),
  );

  if (!parsed.success) {
    throw new Error(failureDiagnostic("schema.valid-fixture", startedAt, "VALID_FIXTURE_REJECTED"));
  }

  expect(parsed.data.scope).toBe("non-product");
});

test("planted stale fixture is rejected by literal and strict-object checks", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(INVALID_FIXTURE, "schema.stale-fixture"),
  );

  if (parsed.success) {
    throw new Error(failureDiagnostic("schema.stale-fixture", startedAt, "STALE_FIXTURE_ACCEPTED"));
  }

  expect(parsed.error.issues.some((issue) => issue.path[0] === "schema")).toBeTrue();
  expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBeTrue();
});

test("S-2 cost receipt source is closed at root and binding keys", () => {
  const receipt = {
    schema_version: S2_COST_RECEIPT_SCHEMA_VERSION,
    record: S2_COST_RECEIPT_RECORD,
    run_id: "s2-contract",
    phase: "exercise",
    revision: "a".repeat(40),
    dirty_state: "clean",
    source_digest: "b".repeat(64),
    scope: "local-workerd-d1-do",
    bindings: { d1: "DB", durable_object: "KRATER_OUTBOX", r2: null },
    status: "pass",
    metric_scope: "selected-settled-write-receipts",
    write_receipt_count: 1,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    write_claim_wall_scope: "writeClaim-entry-to-return",
    p95_write_phase_ms: 1,
    p95_preflight_wall_ms: 1,
    p95_write_claim_wall_ms: 1,
    sum_successful_batch_rows_read: 1,
    sum_successful_batch_rows_written: 1,
    sum_preflight_rows_read: 1,
    sum_preflight_rows_written: 0,
    sum_preflight_statements: 1,
    sum_retry_count: 0,
    known_row_total_exclusions: REQUIRED_ROW_TOTAL_EXCLUSIONS,
  };
  expect(Object.keys(receipt)).toEqual([...S2_COST_RECEIPT_ROOT_KEYS]);
  expect(Object.keys(receipt.bindings)).toEqual([...S2_COST_RECEIPT_BINDINGS_KEYS]);
  expect(S2CostMeasurementReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(S2CostMeasurementReceiptSchema.safeParse({ ...receipt, unexpected: true }).success).toBe(
    false,
  );
  expect(
    S2CostMeasurementReceiptSchema.safeParse({
      ...receipt,
      bindings: { ...receipt.bindings, unexpected: true },
    }).success,
  ).toBe(false);
});

test("S-2 retained evidence manifest is a closed, bounded envelope", () => {
  const manifest = {
    manifest_version: S2_COST_EVIDENCE_MANIFEST_VERSION,
    run_id: "s2-contract",
    revision: "a".repeat(40),
    dirty_state: "clean",
    source_digest: "b".repeat(64),
    exit_code: 78,
    local_phase_status: {
      exercise: "pass",
      restart_verify: "pass",
      upgrade_existing: "pass",
      upgrade_empty: "pass",
      upgrade_journal_existing: "pass",
      upgrade_journal_empty: "pass",
    },
    retention: {
      retained: true,
      deletion_performed: false,
      max_bytes_per_run: 3_000_000,
      max_files_per_run: 7,
      retained_bytes_before_manifest: 1,
      retained_files_before_manifest: 1,
      durable_publication_reservation: {
        retained_names: S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
        reserved_bytes_upper_bound: S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
      },
    },
    s2_cost_receipt: {
      path: "s2-cost-input.json",
      digest: "c".repeat(64),
      bytes: 1,
    },
    files: [{ path: "s2-cost-input.json", bytes: 1, kind: "file" }],
  };
  expect(S2CostEvidenceManifestSchema.safeParse(manifest).success).toBe(true);
  expect(S2CostEvidenceManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(
    false,
  );
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      retention: { ...manifest.retention, unexpected: true },
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], unexpected: true }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], path: "./s2-cost-input.json" }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [...manifest.files, manifest.files[0]],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], bytes: 2 }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      retention: {
        ...manifest.retention,
        max_bytes_per_run: Number.MAX_SAFE_INTEGER,
        retained_bytes_before_manifest: Number.MAX_SAFE_INTEGER,
      },
      files: [{ ...manifest.files[0], bytes: Number.MAX_SAFE_INTEGER }],
    }).success,
  ).toBe(false);
});

test("S-2 publication commit strictly binds all three preceding artifacts", () => {
  const commit = {
    schema_version: S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
    record: S2_COST_PUBLICATION_COMMIT_RECORD,
    manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: "a".repeat(64) },
    receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: "b".repeat(64),
      bytes: 1,
    },
    publication: { path: S2_COST_PUBLICATION_RELATIVE_PATH, digest: "c".repeat(64) },
  };
  expect(S2CostReceiptPublicationCommitSchema.safeParse(commit).success).toBe(true);
  expect(
    S2CostReceiptPublicationCommitSchema.safeParse({ ...commit, unexpected: true }).success,
  ).toBe(false);
  expect(
    S2CostReceiptPublicationCommitSchema.safeParse({
      ...commit,
      receipt: { ...commit.receipt, bytes: -1 },
    }).success,
  ).toBe(false);
});

test("the normal contract generator declares both S-2 receipt artifacts for drift checking", () => {
  expect(generatedArtifacts().map((artifact) => artifact.relativePath)).toEqual(
    expect.arrayContaining([
      "generated/s2-cost-receipt.schema.json",
      "generated/s2-cost-receipt.types.ts",
    ]),
  );
});
