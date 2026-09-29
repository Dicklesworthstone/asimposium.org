import { describe, expect, test } from "bun:test";

import { repairOutcome } from "../../src/krater/projection-replay.ts";

// ys2o: a repair's refusal must describe what it actually wrote. The inserted
// path is proven on real D1 by projection-doctor-real-bindings.mjs step 3b;
// the zero-insert path needs drift that appears between a clean first check
// and the re-check with no insert to hang a trigger on, so it is decided here.
describe("projection repair outcome (ys2o)", () => {
  test("consistent after the re-check is no refusal, whatever was inserted", () => {
    expect(repairOutcome(0, 0)).toBeNull();
    expect(repairOutcome(3, 0)).toBeNull();
  });

  test("drift after committed inserts says rows were inserted", () => {
    expect(repairOutcome(1, 1)).toBe("PROJECTION_REPAIR_INCOMPLETE");
  });

  test("drift with nothing inserted never claims an insert", () => {
    expect(repairOutcome(0, 2)).toBe("PROJECTION_DRIFT_NOT_REPAIRABLE");
  });
});
