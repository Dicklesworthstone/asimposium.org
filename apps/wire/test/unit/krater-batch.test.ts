import { describe, expect, test } from "bun:test";

import { type BatchMember, MAX_BATCH_MEMBERS, planBatchCommit } from "../../src/krater/batch.ts";

function member(tempId: string, causedBy: readonly string[] = []): BatchMember {
  return { tempId, causedBy };
}

describe("batch commit planning (W2.2)", () => {
  test("an empty batch is refused", () => {
    const plan = planBatchCommit([]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("BATCH_EMPTY");
  });

  test("the batch is bounded", () => {
    const members = Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, i) => member(`tmp:${i}`));
    const plan = planBatchCommit(members);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("BATCH_TOO_LARGE");
  });

  test("a duplicate temp id is refused", () => {
    const plan = planBatchCommit([member("tmp:a"), member("tmp:a")]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("BATCH_DUPLICATE_TEMP_ID");
  });

  test("a dangling caused_by reference is refused (the batch is self-contained)", () => {
    const plan = planBatchCommit([member("tmp:a", ["tmp:phantom"])]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("BATCH_DANGLING_CAUSAL_REF");
  });

  test("causal order is topological: parents before dependents", () => {
    const plan = planBatchCommit([
      member("tmp:child", ["tmp:parent"]),
      member("tmp:parent"),
      member("tmp:grandchild", ["tmp:child"]),
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.commitOrder).toEqual(["tmp:parent", "tmp:child", "tmp:grandchild"]);
    }
  });

  test("a causal cycle is refused with the DAG citation (P10)", () => {
    const plan = planBatchCommit([member("tmp:a", ["tmp:b"]), member("tmp:b", ["tmp:a"])]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_CAUSAL_CYCLE");
      expect(plan.detail).toContain("DAG");
    }
  });

  test("independent members keep declaration order (deterministic)", () => {
    const plan = planBatchCommit([member("tmp:z"), member("tmp:a"), member("tmp:m")]);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.commitOrder).toEqual(["tmp:z", "tmp:a", "tmp:m"]);
  });

  test("a diamond dependency commits both parents before the join", () => {
    const plan = planBatchCommit([
      member("tmp:root"),
      member("tmp:left", ["tmp:root"]),
      member("tmp:right", ["tmp:root"]),
      member("tmp:join", ["tmp:left", "tmp:right"]),
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const order = plan.commitOrder;
      expect(order.indexOf("tmp:root")).toBeLessThan(order.indexOf("tmp:left"));
      expect(order.indexOf("tmp:root")).toBeLessThan(order.indexOf("tmp:right"));
      expect(order.indexOf("tmp:left")).toBeLessThan(order.indexOf("tmp:join"));
      expect(order.indexOf("tmp:right")).toBeLessThan(order.indexOf("tmp:join"));
    }
  });
});
