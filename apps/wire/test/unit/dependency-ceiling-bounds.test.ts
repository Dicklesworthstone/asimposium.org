import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CeilingNode,
  computeDependencyCeilings,
} from "../../src/ledger/dependency-ceiling.ts";

const node = (target: string, dependencies: readonly string[] | null = []): CeilingNode => ({
  target, dependencies, standing: {
    complete: true, disposition: "strongly-supported", review_state: "independently-checked",
    stale: false, latest_version: 1, own_ceiling: "certified",
  },
});

for (const target of ["C-1@1\n", "C-1@1\r\n", `C-${"1".repeat(61)}@1`, "C-1@9007199254740992"]) {
  test(`noncanonical or over-budget exact pin is unavailable: ${JSON.stringify(target)}`, () => {
    const result = computeDependencyCeilings([node(target)]).get(target)!;
    assert.equal(result.complete, false);
    assert.equal(result.ceiling, null);
    assert.equal(result.reason, "source-unavailable");
  });
}

test("an exact pin at the public 64-character boundary remains valid", () => {
  const target = `C-${"1".repeat(60)}@1`;
  assert.equal(target.length, 64);
  assert.equal(computeDependencyCeilings([node(target)]).get(target)?.ceiling, "certified");
});

test("an omitted dependency list is unknown history, never an empty certified graph", () => {
  const input = { ...node("C-1@1"), dependencies: undefined } as unknown as CeilingNode;
  assert.deepEqual(computeDependencyCeilings([input]).get("C-1@1"), {
    complete: false, ceiling: null, weakest_path: ["C-1@1"], reason: "dependency-history-unavailable",
  });
});

test("a malformed dependency collection cannot supply a favorable assessment", () => {
  for (const dependencies of ["C-2@1", {}, 0]) {
    const input = { ...node("C-1@1"), dependencies } as unknown as CeilingNode;
    const result = computeDependencyCeilings([input]).get("C-1@1")!;
    assert.equal(result.complete, false);
    assert.equal(result.ceiling, null);
    assert.equal(result.reason, "dependency-history-unavailable");
  }
});

test("malformed dependency pins are not expanded or published as path members", () => {
  for (const target of ["C-2@1\n", "C-2", `C-${"2".repeat(61)}@1`]) {
    const result = computeDependencyCeilings([node("C-1@1", [target])]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get("C-1@1"), {
      complete: false, ceiling: null, weakest_path: ["C-1@1"], reason: "source-unavailable",
    });
  }
});

test("oversized adjacency is rejected before allocating a missing-node expansion", () => {
  const references = Array.from({ length: 10000 }, (_, i) => `C-${i + 2}@1`);
  const results = computeDependencyCeilings([node("C-1@1", references)]);
  assert.equal(results.size, 1);
  assert.equal(results.get("C-1@1")?.complete, false);
  assert.equal(results.get("C-1@1")?.ceiling, null);
});

test("missing nodes count against the same 64-node graph budget", () => {
  const references = Array.from({ length: 63 }, (_, i) => `C-${i + 2}@1`);
  const within = computeDependencyCeilings([node("C-1@1", references)]);
  assert.equal(within.size, 64);
  assert.deepEqual(within.get("C-1@1")?.weakest_path, ["C-1@1", "C-10@1"]);
  const over = computeDependencyCeilings([node("C-1@1", [...references, "C-65@1"])]);
  assert.equal(over.size, 1);
  assert.deepEqual(over.get("C-1@1"), {
    complete: false, ceiling: null, weakest_path: ["C-1@1"], reason: "source-unavailable",
  });
});

test("the combined forest budget cannot return a favorable truncated subset", () => {
  const inputs = Array.from({ length: 20 }, (_, i) => node(`C-${i + 1}@1`,
    Array.from({ length: 3 }, (_, j) => `C-${100 + i * 3 + j}@1`)));
  inputs.push(node("C-99@1"));
  const results = computeDependencyCeilings(inputs);
  assert.equal(results.size, inputs.length);
  for (const item of inputs) {
    assert.deepEqual(results.get(item.target), {
      complete: false, ceiling: null, weakest_path: [item.target], reason: "source-unavailable",
    });
  }
});

test("duplicate edges within the read budget are deduplicated without mutating input", () => {
  const inputs = [node("C-1@1", Array.from({ length: 64 }, () => "C-2@1")), node("C-2@1")];
  const before = JSON.stringify(inputs);
  const results = computeDependencyCeilings(inputs);
  assert.equal(results.get("C-1@1")?.ceiling, "certified");
  assert.equal(results.size, 2);
  assert.equal(JSON.stringify(inputs), before);
});
