import { describe, expect, test } from "bun:test";

import {
  BATCH_PLAN_REFUSAL_CODES,
  BATCH_TEMP_ID_PATTERN,
  type BatchMember,
  MAX_BATCH_MEMBERS,
  MAX_CAUSED_BY_PER_MEMBER,
  planBatchCommit,
} from "../../src/krater/batch.ts";

function member(tempId: string, causedBy: readonly string[] = []): BatchMember {
  return { tempId, causedBy };
}

describe("batch commit planning (W2.2 / asimposiumorg-s96x)", () => {
  test("literal constants are exact", () => {
    expect(MAX_BATCH_MEMBERS).toBe(16);
    expect(MAX_CAUSED_BY_PER_MEMBER).toBe(15);
    expect(BATCH_PLAN_REFUSAL_CODES).toEqual([
      "BATCH_EMPTY",
      "BATCH_TOO_LARGE",
      "BATCH_INVALID_TEMP_ID",
      "BATCH_DUPLICATE_TEMP_ID",
      "BATCH_SELF_CAUSAL_REF",
      "BATCH_DUPLICATE_CAUSAL_REF",
      "BATCH_DANGLING_CAUSAL_REF",
      "BATCH_CAUSAL_CYCLE",
    ]);
  });

  test("a valid singleton batch succeeds", () => {
    const plan = planBatchCommit([member("tmp:solo")]);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.commitOrder).toEqual(["tmp:solo"]);
  });

  test("exact 16-member batch boundary succeeds", () => {
    const members = Array.from({ length: 16 }, (_, i) =>
      member(`tmp:m${i}`, i > 0 ? [`tmp:m${i - 1}`] : []),
    );
    const plan = planBatchCommit(members);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.commitOrder.length).toBe(16);
      expect(plan.commitOrder[0]).toBe("tmp:m0");
      expect(plan.commitOrder[15]).toBe("tmp:m15");
    }
  });

  test("an empty batch is refused with BATCH_EMPTY", () => {
    const plan = planBatchCommit([]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_EMPTY");
      expect(plan.detail).toContain("at least one member");
    }
  });

  test("a 17-member batch exceeding bound is refused with BATCH_TOO_LARGE", () => {
    const members = Array.from({ length: 17 }, (_, i) => member(`tmp:m${i}`));
    const plan = planBatchCommit(members);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_TOO_LARGE");
      expect(plan.detail).toContain("exceeds the 16-member bound");
    }
  });

  describe("temporary ID validation", () => {
    test("valid temp IDs match pattern", () => {
      const validIds = [
        "tmp:a",
        "tmp:1",
        "tmp:claim-1",
        "tmp:hypothesis_a.1:step-2",
        `tmp:${"x".repeat(124)}`,
      ];
      for (const id of validIds) {
        expect(BATCH_TEMP_ID_PATTERN.test(id)).toBe(true);
        const plan = planBatchCommit([member(id)]);
        expect(plan.ok).toBe(true);
      }
    });

    test("refuses non-tmp prefix, empty, or control-bearing tempId with BATCH_INVALID_TEMP_ID", () => {
      const invalidIds = [
        "",
        "plain-id",
        "tmp:",
        "tmp: leading",
        "tmp:trailing ",
        "tmp:has\nnewline",
        "tmp:has\0null",
        "tmp:has`backtick",
        'tmp:has"quote',
        `tmp:${"x".repeat(125)}`, // 129 chars
      ];
      for (const id of invalidIds) {
        const plan = planBatchCommit([member(id)]);
        expect(plan.ok).toBe(false);
        if (!plan.ok) {
          expect(plan.code).toBe("BATCH_INVALID_TEMP_ID");
          expect(plan.detail).not.toContain("\n");
          expect(plan.detail).not.toContain("\0");
        }
      }
    });

    test("refuses invalid tempId in causedBy with BATCH_INVALID_TEMP_ID", () => {
      const plan = planBatchCommit([
        member("tmp:a", ["invalid-parent"]),
        member("tmp:b"),
      ]);
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.code).toBe("BATCH_INVALID_TEMP_ID");
      }
    });
  });

  test("a duplicate temp id is refused with BATCH_DUPLICATE_TEMP_ID", () => {
    const plan = planBatchCommit([member("tmp:a"), member("tmp:a")]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_DUPLICATE_TEMP_ID");
      expect(plan.detail).toContain("tmp:a");
    }
  });

  test("a member referencing itself in causedBy is refused with BATCH_SELF_CAUSAL_REF", () => {
    const plan = planBatchCommit([member("tmp:self", ["tmp:self"])]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_SELF_CAUSAL_REF");
      expect(plan.detail).toContain("cannot list itself");
    }
  });

  test("duplicate causedBy parent references are refused with BATCH_DUPLICATE_CAUSAL_REF", () => {
    const plan = planBatchCommit([
      member("tmp:parent"),
      member("tmp:child", ["tmp:parent", "tmp:parent"]),
    ]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_DUPLICATE_CAUSAL_REF");
      expect(plan.detail).toContain("duplicate caused_by reference");
    }
  });

  test("exceeding MAX_CAUSED_BY_PER_MEMBER is refused with BATCH_TOO_LARGE", () => {
    const parents = Array.from({ length: 16 }, (_, i) => `tmp:p${i}`);
    const members = [
      ...parents.map((p) => member(p)),
      member("tmp:child", parents),
    ];
    // Note: total members is 17 here, which is caught by BATCH_TOO_LARGE
    const plan = planBatchCommit(members);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("BATCH_TOO_LARGE");
  });

  test("a dangling caused_by reference is refused with BATCH_DANGLING_CAUSAL_REF", () => {
    const plan = planBatchCommit([member("tmp:a", ["tmp:phantom"])]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_DANGLING_CAUSAL_REF");
      expect(plan.detail).toContain("not a member of this batch");
    }
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

  test("a 2-cycle is refused with BATCH_CAUSAL_CYCLE and DAG (P10) citation", () => {
    const plan = planBatchCommit([
      member("tmp:a", ["tmp:b"]),
      member("tmp:b", ["tmp:a"]),
    ]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_CAUSAL_CYCLE");
      expect(plan.detail).toContain("DAG (P10)");
    }
  });

  test("a 3-cycle is refused with BATCH_CAUSAL_CYCLE", () => {
    const plan = planBatchCommit([
      member("tmp:a", ["tmp:c"]),
      member("tmp:b", ["tmp:a"]),
      member("tmp:c", ["tmp:b"]),
    ]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("BATCH_CAUSAL_CYCLE");
      expect(plan.detail).toContain("DAG (P10)");
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

  test("complex multi-branch DAG resolves deterministically", () => {
    const plan = planBatchCommit([
      member("tmp:m3", ["tmp:m1", "tmp:m2"]),
      member("tmp:m1"),
      member("tmp:m2"),
      member("tmp:m4", ["tmp:m3"]),
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.commitOrder).toEqual(["tmp:m1", "tmp:m2", "tmp:m3", "tmp:m4"]);
    }
  });
});
