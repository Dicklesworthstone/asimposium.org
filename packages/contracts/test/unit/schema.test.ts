import { expect, test } from "bun:test";

import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import { ContractScaffoldSchema } from "../../src/schema.ts";
import {
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_RECEIPT_BINDINGS_KEYS,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_ROOT_KEYS,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2CostMeasurementReceiptSchema,
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
