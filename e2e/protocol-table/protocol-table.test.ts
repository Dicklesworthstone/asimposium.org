import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import {
  type ProtocolFixtureResult,
  runProtocolFixtureTable,
  runScientificStateMachineTable,
} from "./table.ts";

interface SnapshotDoc {
  readonly schema: "asimposium.protocol-table-snapshots.v1";
  readonly protocol_refusals: Record<
    string,
    {
      readonly rule_id: string;
      readonly error_code: string;
      readonly rfc7807: ProtocolFixtureResult["rfc7807"];
    }
  >;
}

describe("W10.2 Protocol fixture table (P1-P13) + scientific state-machine table (asimposiumorg-phs)", () => {
  const snapshots = JSON.parse(
    readFileSync(join(import.meta.dir, "snapshots.json"), "utf8"),
  ) as SnapshotDoc;

  test("Protocol fixture table: all 11 hard-rule refusals match RFC 7807 snapshots and pass should-fail controls", async () => {
    const rows = await runProtocolFixtureTable();
    expect(rows.length).toBe(11);

    const actualKeys = rows.map((r) => r.id).sort();
    expect(actualKeys).toEqual(Object.keys(snapshots.protocol_refusals).sort());

    for (const row of rows) {
      expect(row.validator_refused, `${row.id} validator must refuse`).toBe(true);
      expect(row.should_fail_control_passed, `${row.id} should-fail control must pass`).toBe(true);
      expect(() => ProblemDocumentSchema.parse(row.rfc7807)).not.toThrow();

      const snap = snapshots.protocol_refusals[row.id];
      expect(snap, `missing snapshot for ${row.id}`).toBeDefined();
      expect(row.rule_id).toBe(snap?.rule_id);
      expect(row.error_code).toBe(snap?.error_code);
      expect(row.rfc7807).toEqual(snap?.rfc7807);
    }
  });

  test("Scientific state-machine table: all 8 invariants hold and pass should-fail controls", async () => {
    const rows = await runScientificStateMachineTable();
    expect(rows.length).toBe(8);

    for (const row of rows) {
      expect(row.observed, row.id).toBe(row.expected);
      expect(row.passed, `${row.id} invariant must hold`).toBe(true);
      expect(row.should_fail_control_passed, `${row.id} should-fail control must pass`).toBe(true);
    }
  });
});
