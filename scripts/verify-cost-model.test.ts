import { describe, expect, test } from "bun:test";

import {
  buildCostVerifierDiagnostic,
  calculateFableWorkload,
  FABLE_WORKED_EXAMPLE,
  FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
  MAX_S2_COST_RECEIPT_BYTES,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  receiptDigest,
  runCostVerifierCli,
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
  return JSON.parse(new TextDecoder().decode(receiptBytes())) as Record<string, unknown>;
}

function assertInvalidReceipt(receipt: Record<string, unknown>): void {
  expect(verifyCostModel(FABLE_WORKED_EXAMPLE, JSON.stringify(receipt))).toMatchObject({
    status: "blocked",
    code: "S2_COST_RECEIPT_INVALID",
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
    const invalid = verifyCostModel(FABLE_WORKED_EXAMPLE, "{");
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

  test("caps receipt bytes and keeps malformed missing and argument failures distinct and safe", () => {
    const oversized = new Uint8Array(MAX_S2_COST_RECEIPT_BYTES + 1);
    expect(verifyCostModel(FABLE_WORKED_EXAMPLE, oversized)).toMatchObject({
      status: "blocked",
      code: "S2_COST_RECEIPT_TOO_LARGE",
    });

    const noReceipt = runCostVerifierCli([]);
    const argumentError = runCostVerifierCli(["--receipt"]);
    const malformedContent = "{s7-raw-content-should-not-appear";
    const suppliedPath = "/Users/sensitive/s7-cost-receipt.json";
    const malformed = runCostVerifierCli(["--receipt", suppliedPath], () =>
      new TextEncoder().encode(malformedContent),
    );
    const missing = runCostVerifierCli(["--receipt", "s7-receipt-that-does-not-exist.json"]);
    const tooLarge = runCostVerifierCli(["--receipt", suppliedPath], () => oversized);

    expect(noReceipt.cost_model).toMatchObject({ code: "S2_COST_MEASUREMENT_UNAVAILABLE" });
    expect(argumentError.cost_model).toMatchObject({ code: "COST_MODEL_ARGUMENT_INVALID" });
    expect(malformed.cost_model).toMatchObject({ code: "S2_COST_RECEIPT_INVALID" });
    expect(missing.cost_model).toMatchObject({ code: "S2_COST_MEASUREMENT_UNAVAILABLE" });
    expect(tooLarge.cost_model).toMatchObject({ code: "S2_COST_RECEIPT_TOO_LARGE" });

    for (const diagnostic of [argumentError, malformed, missing, tooLarge]) {
      const serialized = JSON.stringify(diagnostic);
      expect(serialized).not.toContain(suppliedPath);
      expect(serialized).not.toContain(malformedContent);
      expect(serialized).not.toContain("s7-receipt-that-does-not-exist.json");
    }
  });

  test("standalone CLI returns an honest blocked diagnostic and exit 78", () => {
    const completed = Bun.spawnSync({
      cmd: [process.execPath, "scripts/verify-cost-model.ts", "--receipt"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(completed.stdout);
    expect(completed.exitCode).toBe(78);
    expect(JSON.parse(output)).toMatchObject({
      status: "blocked",
      code: "COST_MODEL_ARGUMENT_INVALID",
    });
    expect(output).not.toContain("/Users/");
  });
});
