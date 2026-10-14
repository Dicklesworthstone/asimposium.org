import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CeilingNode,
  computeDependencyCeilings,
  type PremiseStanding,
} from "../../src/ledger/dependency-ceiling";

const standing = (overrides: Partial<PremiseStanding> = {}): PremiseStanding => ({
  complete: true, disposition: "strongly-supported", review_state: "independently-checked",
  stale: false, latest_version: 1, own_ceiling: "certified", ...overrides,
});
const node = (
  target: string, dependencies: readonly string[] | null = [],
  overrides: Partial<PremiseStanding> = {},
): CeilingNode => ({ target, dependencies, standing: standing(overrides) });

const classes = ["assertion", "heuristic", "citation", "computation", "certified"] as const;
for (const [ownRank, own] of classes.entries()) {
  for (const [premiseRank, premise] of classes.entries()) {
    test(`minimum of ${own} and ${premise} never upgrades the chain`, () => {
      const result = computeDependencyCeilings([
        node("C-2@1", ["C-1@1"], { own_ceiling: own }),
        node("C-1@1", [], { own_ceiling: premise }),
      ]).get("C-2@1")!;
      assert.equal(result.ceiling, classes[Math.min(ownRank, premiseRank)]);
      assert.equal(result.complete, true);
      assert.deepEqual(result.weakest_path, premiseRank < ownRank ? ["C-2@1", "C-1@1"] : ["C-2@1"]);
    });
  }
}

test("a deep weak premise is surfaced with its full exact-version path", () => {
  const result = computeDependencyCeilings([
    node("C-4@1", ["C-3@1"]), node("C-3@1", ["C-2@1"]),
    node("C-2@1", ["C-1@1"]), node("C-1@1", [], { own_ceiling: "assertion" }),
  ]).get("C-4@1")!;
  assert.equal(result.ceiling, "assertion");
  assert.deepEqual(result.weakest_path, ["C-4@1", "C-3@1", "C-2@1", "C-1@1"]);
});

test("a diamond chooses the shortest limiting path, independently of input order", () => {
  const nodes = [node("C-4@1", ["C-3@1", "C-1@1"]), node("C-3@1", ["C-1@1"]),
    node("C-1@1", [], { own_ceiling: "citation" })];
  const before = JSON.stringify(nodes);
  for (const inputs of [nodes, [...nodes].reverse()]) {
    const result = computeDependencyCeilings(inputs).get("C-4@1")!;
    assert.deepEqual(result.weakest_path, ["C-4@1", "C-1@1"]);
  }
  assert.equal(JSON.stringify(nodes), before);
});

test("equal weakest premises have deterministic lexical tie-breaking", () => {
  const result = computeDependencyCeilings([node("C-3@1", ["C-2@1", "C-1@1"]),
    node("C-2@1", [], { own_ceiling: "citation" }), node("C-1@1", [], { own_ceiling: "citation" })]);
  assert.deepEqual(result.get("C-3@1")?.weakest_path, ["C-3@1", "C-1@1"]);
});

for (const [label, overrides] of Object.entries({
  incomplete: { complete: false }, stale: { stale: true }, absent: { own_ceiling: null },
  unknown: { disposition: null }, noHead: { latest_version: null },
} satisfies Record<string, Partial<PremiseStanding>>)) {
  test(`${label} input cannot lend strength, even to an assertion-class parent`, () => {
    const result = computeDependencyCeilings([
      node("C-2@1", ["C-1@1"], { own_ceiling: "assertion" }), node("C-1@1", [], overrides),
    ]).get("C-2@1")!;
    assert.equal(result.ceiling, null);
    assert.equal(result.complete, false);
    assert.equal(result.reason, "source-unavailable");
    assert.deepEqual(result.weakest_path, ["C-2@1", "C-1@1"]);
  });
}

for (const disposition of ["draft", "malformed", "refuted", "withdrawn", "superseded"] as const) {
  test(`${disposition} premise blocks a favorable chain assessment`, () => {
    const result = computeDependencyCeilings([node("C-2@1", ["C-1@1"]),
      node("C-1@1", [], { disposition })]).get("C-2@1")!;
    assert.equal(result.ceiling, null);
    assert.equal(result.reason, "premise-inactive");
  });
}

for (const overrides of [{ disposition: "disputed" as const }, { review_state: "contested" as const }]) {
  test(`contested premise is not hidden by ${JSON.stringify(overrides)}`, () => {
    assert.equal(computeDependencyCeilings([node("C-2@1", ["C-1@1"]),
      node("C-1@1", [], overrides)]).get("C-2@1")?.reason, "premise-contested");
  });
}

test("new head does not silently replace the version a dependent published", () => {
  const result = computeDependencyCeilings([node("C-2@1", ["C-1@1"]),
    node("C-1@1", [], { latest_version: 2, own_ceiling: "assertion" }),
    node("C-1@2", [], { latest_version: 2 })]);
  assert.equal(result.get("C-2@1")?.ceiling, null);
  assert.equal(result.get("C-2@1")?.reason, "premise-not-current");
  assert.equal(result.get("C-1@2")?.ceiling, "certified");
});

test("missing node and unknown legacy history are not empty graphs", () => {
  const missing = computeDependencyCeilings([node("C-2@1", ["C-1@1"])]).get("C-2@1")!;
  assert.equal(missing.reason, "source-unavailable");
  const legacy = computeDependencyCeilings([node("C-2@1", ["C-1@1"]), node("C-1@1", null)]).get("C-2@1")!;
  assert.equal(legacy.reason, "dependency-history-unavailable");
  assert.equal(legacy.ceiling, null);
});

test("cycles terminate without presenting a favorable ceiling", () => {
  for (const nodes of [[node("C-1@1", ["C-1@1"])],
    [node("C-1@1", ["C-2@1"]), node("C-2@1", ["C-1@1"])]]) {
    const results = computeDependencyCeilings(nodes);
    for (const result of results.values()) {
      assert.equal(result.ceiling, null);
      assert.equal(result.reason, "dependency-cycle");
    }
  }
});

test("conflicting duplicate nodes fail closed instead of last-write-wins", () => {
  const results = computeDependencyCeilings([node("C-2@1", ["C-1@1"]),
    node("C-1@1", [], { own_ceiling: "assertion" }), node("C-1@1")]);
  assert.equal(results.get("C-2@1")?.ceiling, null);
});

test("64-node chain is supported; over-bound inputs are unavailable", () => {
  const nodes = Array.from({ length: 64 }, (_, i) => node(`C-${i + 1}@1`, i ? [`C-${i}@1`] : [],
    i ? {} : { own_ceiling: "heuristic" }));
  assert.equal(computeDependencyCeilings(nodes).get("C-64@1")?.weakest_path.length, 64);
  assert.equal(computeDependencyCeilings([...nodes, node("C-65@1")]).get("C-64@1")?.ceiling, null);
});
