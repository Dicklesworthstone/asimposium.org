import { describe, expect, test } from "bun:test";

import {
  buildCostVerifierDiagnostic,
  calculateFableWorkload,
  FABLE_WORKED_EXAMPLE,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  receiptDigest,
  S2_COST_METRIC_SCOPE,
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

function verifiedFixture(receipt = validReceipt()) {
  const bytes = JSON.stringify(receipt);
  return verifyCostModel(FABLE_WORKED_EXAMPLE, receipt, bytes, {
    run_id: receipt.run_id,
    revision: receipt.revision,
    source_digest: receipt.source_digest,
  });
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

  test("accepts only a complete scoped S2 cost receipt", () => {
    const accepted = verifiedFixture();
    expect(accepted.code).toBe("COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE");
    expect(accepted.s2).toMatchObject({
      state: "accepted-local",
      scope: S2_LOCAL_SCOPE,
      metric_scope: S2_COST_METRIC_SCOPE,
      write_receipt_count: 3,
    });

    const invalid = verifyCostModel(
      FABLE_WORKED_EXAMPLE,
      { ...validReceipt(), write_receipt_count: 0 },
      JSON.stringify(validReceipt()),
    );
    expect(invalid).toMatchObject({ status: "blocked", code: "S2_COST_RECEIPT_INVALID" });
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

  test("blocks instead of zero-filling absent CPU R2 DO pack delta cursor or price inputs", () => {
    const result = verifyCostModel();
    expect(result).toMatchObject({ status: "blocked", code: "S2_COST_MEASUREMENT_UNAVAILABLE" });
    expect(result.unknowns).toEqual(
      expect.arrayContaining([
        "worker_cpu_ms",
        "r2_operations_and_storage",
        "durable_object_alarm_cost",
        "pack_delta_and_cursor_rows",
        "provider_price",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('"worker_cpu_ms":0');
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
      artifact_digest: receiptDigest(JSON.stringify(validReceipt())),
    });
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("asimp_ag_");
    expect(serialized).not.toContain("#v1.");
    expect(serialized).not.toMatch(/authorization|cookie|workshop text/i);
  });

  test("mutating metric scope exclusion or provenance makes the result blocked", () => {
    const mutations: Array<[string, unknown, Parameters<typeof verifyCostModel>[3]]> = [
      ["metric scope", { ...validReceipt(), metric_scope: "all-d1-rows" }, undefined],
      [
        "exclusion",
        { ...validReceipt(), known_row_total_exclusions: ["failed-retry-batches-no-meta"] },
        undefined,
      ],
      ["provenance", validReceipt(), { source_digest: "c".repeat(64) }],
    ];

    for (const [_name, receipt, provenance] of mutations) {
      const result = verifyCostModel(
        FABLE_WORKED_EXAMPLE,
        receipt,
        JSON.stringify(receipt),
        provenance,
      );
      expect(result).toMatchObject({ status: "blocked", code: "S2_COST_RECEIPT_INVALID" });
    }
  });

  test("receipt digest binds the exact bytes", () => {
    const original = JSON.stringify(validReceipt());
    const mutated = JSON.stringify({ ...validReceipt(), sum_retry_count: 2 });
    expect(receiptDigest(original)).toHaveLength(64);
    expect(receiptDigest(mutated)).not.toBe(receiptDigest(original));
  });
});
