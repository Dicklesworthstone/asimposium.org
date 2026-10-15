import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CeilingNode,
  computeDependencyCeilings,
  type PremiseStanding,
} from "../../src/ledger/dependency-ceiling.ts";

const node = (
  target: string,
  dependencies: readonly string[] | null = [],
  overrides: Partial<PremiseStanding> = {},
): CeilingNode => ({ target, dependencies, standing: {
  complete: true, disposition: "strongly-supported", review_state: "independently-checked",
  stale: false, latest_version: 1, own_ceiling: "certified", ...overrides,
} });

function assertCycleWitness(nodes: readonly CeilingNode[], root: string, expected: readonly string[]) {
  const result = computeDependencyCeilings(nodes).get(root)!;
  assert.equal(result.complete, false);
  assert.equal(result.ceiling, null);
  assert.equal(result.reason, "dependency-cycle");
  assert.deepEqual(result.weakest_path, expected);
  assert.equal(result.weakest_path[0], root);
  assert(result.weakest_path.slice(0, -1).includes(result.weakest_path.at(-1)!));
  const edges = new Map(nodes.map((item) => [item.target, item.dependencies]));
  for (let i = 1; i < result.weakest_path.length; i++) {
    assert(edges.get(result.weakest_path[i - 1]!)?.includes(result.weakest_path[i]!));
  }
}

test("every root in a cycle gets a complete closing-edge witness", () => {
  const graph = [node("C-1@1", ["C-2@1"]), node("C-2@1", ["C-1@1"])];
  assertCycleWitness(graph, "C-1@1", ["C-1@1", "C-2@1", "C-1@1"]);
  assertCycleWitness(graph, "C-2@1", ["C-2@1", "C-1@1", "C-2@1"]);
});

test("an acyclic ancestor gets its own shortest reachable cycle witness", () => {
  const graph = [node("C-1@1", ["C-2@1"]), node("C-2@1", ["C-1@1"]),
    node("C-3@1", ["C-2@1"])];
  assertCycleWitness(graph, "C-3@1", ["C-3@1", "C-2@1", "C-1@1", "C-2@1"]);
});

test("adding an unrelated ancestor cannot change an existing cycle assessment", () => {
  const graph = [node("C-2@1", ["C-3@1"]), node("C-3@1", ["C-2@1"])];
  const before = computeDependencyCeilings(graph);
  const after = computeDependencyCeilings([node("C-1@1", ["C-3@1"]), ...graph]);
  for (const root of ["C-2@1", "C-3@1"]) assert.deepEqual(after.get(root), before.get(root));
});

test("overlapping cycles prefer the shortest cycle, not the first DFS back edge", () => {
  const graph = [node("C-1@1", ["C-2@1", "C-3@1"]),
    node("C-2@1", ["C-3@1"]), node("C-3@1", ["C-1@1"])];
  assertCycleWitness(graph, "C-1@1", ["C-1@1", "C-3@1", "C-1@1"]);
  assertCycleWitness(graph, "C-2@1", ["C-2@1", "C-3@1", "C-1@1", "C-2@1"]);
  assertCycleWitness(graph, "C-3@1", ["C-3@1", "C-1@1", "C-3@1"]);
});

test("self cycles close explicitly and beat a longer reachable cycle", () => {
  const graph = [node("C-1@1", ["C-2@1", "C-1@1"]), node("C-2@1", ["C-1@1"])];
  assertCycleWitness(graph, "C-1@1", ["C-1@1", "C-1@1"]);
});

test("equal-length cycle witnesses use lexical paths rather than insertion order", () => {
  const graph = [node("C-3@1", ["C-2@1", "C-1@1"]),
    node("C-2@1", ["C-3@1"]), node("C-1@1", ["C-3@1"])];
  const original = JSON.stringify(graph);
  for (const inputs of [graph, [...graph].reverse(), graph.map((item) => ({
    ...item, dependencies: [...item.dependencies!].reverse(),
  }))]) {
    assertCycleWitness(inputs, "C-3@1", ["C-3@1", "C-1@1", "C-3@1"]);
  }
  assert.equal(JSON.stringify(graph), original);
});

test("a nearer unavailable source outranks a cycle without becoming assertion evidence", () => {
  const graph = [node("C-1@1", ["C-2@1", "C-9@1"]), node("C-2@1", ["C-1@1"])];
  const result = computeDependencyCeilings(graph).get("C-1@1")!;
  assert.deepEqual(result, {
    complete: false, ceiling: null, weakest_path: ["C-1@1", "C-9@1"], reason: "source-unavailable",
  });
});

test("incomplete history is a barrier: descendants cannot manufacture an auditable path", () => {
  const graph = [node("C-1@1", ["C-2@1"]), node("C-2@1", null),
    node("C-3@1", ["C-3@1"])];
  const result = computeDependencyCeilings(graph).get("C-1@1")!;
  assert.deepEqual(result, { complete: false, ceiling: null,
    weakest_path: ["C-1@1", "C-2@1"], reason: "dependency-history-unavailable" });
});

test("a full 64-node cycle has a bounded, closed witness from every exact pin", () => {
  const graph = Array.from({ length: 64 }, (_, i) => node(`C-${i + 1}@1`, [`C-${(i + 1) % 64 + 1}@1`]));
  const results = computeDependencyCeilings(graph);
  for (const root of graph) {
    const result = results.get(root.target)!;
    assert.equal(result.reason, "dependency-cycle");
    assert.equal(result.ceiling, null);
    assert.equal(result.weakest_path.length, 65);
    assert.equal(result.weakest_path[0], root.target);
    assert.equal(result.weakest_path.at(-1), root.target);
  }
});

test("all three-node directed graphs agree with an independent shortest-walk oracle", () => {
  const targets = ["C-1@1", "C-2@1", "C-3@1"];
  for (let mask = 0; mask < 1 << 9; mask++) {
    const graph = targets.map((target, from) => node(target,
      targets.filter((_, to) => mask & (1 << (from * 3 + to)))));
    const results = computeDependencyCeilings(graph);
    const edges = new Map(graph.map((item) => [item.target, item.dependencies!]));
    for (const root of targets) {
      // Enumerate walks in breadth-first lexical order, stopping at their first
      // repeated node. This deliberately shares no memoization with production.
      const queue = [[root]];
      let expected: string[] | undefined;
      for (let index = 0; index < queue.length; index++) {
        const path = queue[index]!;
        const last = path.at(-1)!;
        if (path.slice(0, -1).includes(last)) { expected = path; break; }
        for (const child of edges.get(last)!) queue.push([...path, child]);
      }
      const result = results.get(root)!;
      assert.deepEqual(result, expected ? {
        complete: false, ceiling: null, reason: "dependency-cycle", weakest_path: expected,
      } : {
        complete: true, ceiling: "certified", reason: "weakest-evidence", weakest_path: [root],
      }, `graph ${mask}, root ${root}`);
    }
  }
});
