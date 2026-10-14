import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimDependencySnapshot } from "../../src/ledger/claim-dependency-snapshot.ts";
import { computeDependencyCeilings, type CeilingNode } from "../../src/ledger/dependency-ceiling.ts";
import { pickFormalizationFocus } from "../../src/mega-commands/formalize-dependency-target.ts";

function node(target: string, dependencies: string[] = [], overrides: Partial<CeilingNode["standing"]> = {}): CeilingNode {
  return { target, dependencies, standing: {
    complete: true, disposition: "corroborated", review_state: "independently-checked",
    stale: false, latest_version: Number(target.split("@")[1]), own_ceiling: "computation", ...overrides,
  } };
}
function fixture(nodes = [
  node("C-3@1", ["C-2@1"]), node("C-2@1", ["C-1@1"]), node("C-1@1", [], { own_ceiling: "citation" }),
]) {
  const target = nodes[0]!.target;
  const chains = computeDependencyCeilings(nodes);
  const snapshot: ClaimDependencySnapshot = {
    problem: "P-TEST", through: 20, target,
    closure: {
      root_available: true, complete: true, unavailable: [],
      // The picker deliberately consumes verified edges/standing, not author text.
      nodes: nodes.slice(1).map((n) => ({ target: n.target })) as ClaimDependencySnapshot["closure"]["nodes"],
      edges: nodes.flatMap((n) => (n.dependencies ?? []).map((to) => ({ from: n.target, to, available: true }))),
    },
    assessments: new Map(nodes.map((n) => [n.target, {
      scope: "publication-pins", problem: "P-TEST", target: n.target, through: 20,
      standing: n.standing, chain: chains.get(n.target)!,
    }])),
  };
  const expected = { problem: "P-TEST", target, through: 20, disposition: nodes[0]!.standing.disposition! };
  return { snapshot, expected, pick: () => pickFormalizationFocus(snapshot, expected) };
}
function selected(f = fixture()) {
  const result = f.pick(); assert.equal(result.kind, "selected");
  if (result.kind !== "selected") throw new Error("No focus");
  return result.focus;
}
function replaceAssessment(f: ReturnType<typeof fixture>, target: string, replacement: Record<string, unknown>) {
  const map = f.snapshot.assessments as Map<string, unknown>;
  map.set(target, { ...f.snapshot.assessments.get(target)!, ...replacement });
}

test("formalization follows the weaker transitive publication instead of the parent evidence", () => {
  const focus = selected();
  assert.equal(focus.target, "C-1@1");
  assert.equal(focus.priorityRoot, "C-3@1");
  assert.deepEqual(focus.dependencyPath, ["C-3@1", "C-2@1", "C-1@1"]);
  assert.deepEqual(focus.limitingPath, focus.dependencyPath);
  assert.equal(focus.standing.own_ceiling, "citation");
  assert.equal(focus.priorityChain.ceiling, "citation");
});

test("an unreviewed leaf does not inherit its parent's authority to become a formalization target", () => {
  const focus = selected(fixture([
    node("C-3@1", ["C-2@1"]), node("C-2@1", ["C-1@1"]),
    node("C-1@1", [], { disposition: "open", review_state: "unreviewed", own_ceiling: "assertion" }),
  ]));
  assert.equal(focus.target, "C-2@1");
  assert.deepEqual(focus.dependencyPath, ["C-3@1", "C-2@1"]);
  assert.deepEqual(focus.limitingPath, ["C-3@1", "C-2@1", "C-1@1"]);
  assert.equal(focus.chain.ceiling, "assertion");
});

test("already certified parents may still depend on a weaker reviewed premise", () => {
  const focus = selected(fixture([
    node("C-2@1", ["C-1@1"], { own_ceiling: "certified" }), node("C-1@1", [], { own_ceiling: "heuristic" }),
  ]));
  assert.equal(focus.target, "C-1@1");
});

test("an independently checked leaf with no outstanding formalization is not duplicated", () => {
  assert.deepEqual(fixture([node("C-1@1", [], { own_ceiling: "certified" })]).pick(), { kind: "not-applicable" });
});

test("a certified parent with an unreviewed weak leaf does not manufacture a reviewed target", () => {
  assert.deepEqual(fixture([
    node("C-2@1", ["C-1@1"], { own_ceiling: "certified" }),
    node("C-1@1", [], { disposition: "open", review_state: "unreviewed", own_ceiling: "assertion" }),
  ]).pick(), { kind: "not-applicable" });
});

test("a dispute can merit formal rechecking without asserting a favorable chain ceiling", () => {
  const focus = selected(fixture([node("C-1@1", [], { own_ceiling: "certified", disposition: "disputed", review_state: "contested" })]));
  assert.equal(focus.target, "C-1@1");
  assert.equal(focus.chain.ceiling, null);
  assert.equal(focus.chain.reason, "premise-contested");
});

test("a contested premise, not an unrelated sibling, becomes the exact target", () => {
  const focus = selected(fixture([
    node("C-4@1", ["C-2@1", "C-3@1"]), node("C-2@1", ["C-1@1"]),
    node("C-3@1", [], { own_ceiling: "assertion" }),
    node("C-1@1", [], { disposition: "disputed", review_state: "contested" }),
  ]));
  assert.equal(focus.target, "C-1@1");
  assert.deepEqual(focus.limitingPath, ["C-4@1", "C-2@1", "C-1@1"]);
});

for (const own_ceiling of ["assertion", "heuristic", "citation", "computation"] as const) {
  test(`reviewed ${own_ceiling} can motivate work without a new status`, () => {
    const focus = selected(fixture([node("C-1@1", [], { own_ceiling })]));
    assert.equal(focus.standing.disposition, "corroborated");
    assert.equal(focus.standing.own_ceiling, own_ceiling);
  });
}

for (const change of [
  { complete: false }, { stale: true }, { latest_version: 2 }, { latest_version: null },
  { disposition: "withdrawn" }, { disposition: "refuted" }, { disposition: "malformed" },
  { disposition: "superseded" }, { disposition: "draft" }, { disposition: null },
  { own_ceiling: null }, { own_ceiling: "proved" }, { review_state: null }, { review_state: "certified" },
]) {
  test(`closed or incomplete transitive input refuses work selection: ${JSON.stringify(change)}`, () => {
    const f = fixture();
    replaceAssessment(f, "C-1@1", { standing: { ...f.snapshot.assessments.get("C-1@1")!.standing, ...change } });
    assert.deepEqual(f.pick(), { kind: "unavailable" });
  });
}

test("a root dispute cannot conceal a withdrawn premise on another branch", () => {
  const f = fixture([
    node("C-2@1", ["C-1@1"], { disposition: "disputed" }),
    node("C-1@1", [], { disposition: "withdrawn" }),
  ]);
  assert.deepEqual(f.pick(), { kind: "unavailable" });
});

for (const change of [{ problem: "P-OTHER" }, { target: "C-5@1" }, { through: 21 }, { scope: "mutable-heads" }]) {
  for (const target of ["C-3@1", "C-1@1"]) {
    test(`all assessment identities bind the cut: ${target} ${JSON.stringify(change)}`, () => {
      const f = fixture(); replaceAssessment(f, target, change);
      assert.deepEqual(f.pick(), { kind: "unavailable" });
    });
  }
}

for (const change of [{ problem: "P-OTHER" }, { target: "C-9@1" }, { through: 21 }]) {
  test(`snapshot identity binds the admission: ${JSON.stringify(change)}`, () => {
    const f = fixture(); Object.assign(f.snapshot, change);
    assert.deepEqual(f.pick(), { kind: "unavailable" });
  });
}

test("queue standing cannot be borrowed from a different snapshot", () => {
  const f = fixture(); f.expected.disposition = "disputed";
  assert.deepEqual(f.pick(), { kind: "unavailable" });
});

for (const mutation of [
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.complete = false; },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.root_available = false; },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.unavailable.push("C-1@1"); },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.edges[0]!.available = false; },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.edges.splice(0, 1); },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.edges[0]!.to = "C-99@1"; },
  (f: ReturnType<typeof fixture>) => { f.snapshot.closure.nodes.push(f.snapshot.closure.nodes[0]!); },
  (f: ReturnType<typeof fixture>) => { (f.snapshot.assessments as Map<string, unknown>).delete("C-1@1"); },
]) {
  test(`unavailable and detached graph records are not routed: ${mutation.toString()}`, () => {
    const f = fixture(); mutation(f); assert.deepEqual(f.pick(), { kind: "unavailable" });
  });
}

for (const change of [{ ceiling: "certified" }, { complete: false }, { reason: "source-unavailable" },
  { weakest_path: ["C-3@1", "C-1@1"] }, { weakest_path: ["C-3@1", "C-99@1"] },
  { weakest_path: ["C-3@1", "not-a-claim"] }]) {
  test(`inconsistent chain metadata cannot redirect work: ${JSON.stringify(change)}`, () => {
    const f = fixture(); replaceAssessment(f, "C-3@1", { chain: { ...f.snapshot.assessments.get("C-3@1")!.chain, ...change } });
    assert.deepEqual(f.pick(), { kind: "unavailable" });
  });
}

test("cycles do not create a formalization path", () => {
  assert.deepEqual(fixture([node("C-2@1", ["C-1@1"]), node("C-1@1", ["C-2@1"])]).pick(), { kind: "unavailable" });
});

test("diamonds choose the same shortest path independently of row and edge order", () => {
  const nodes = [node("C-4@1", ["C-3@1", "C-2@1"]), node("C-3@1", ["C-1@1"]),
    node("C-2@1", ["C-1@1"]), node("C-1@1", [], { own_ceiling: "citation" })];
  const a = selected(fixture(nodes));
  const f = fixture([nodes[0]!, ...nodes.slice(1).reverse()]); f.snapshot.closure.edges.reverse();
  assert.deepEqual(a, selected(f));
  assert.deepEqual(a.limitingPath, ["C-4@1", "C-2@1", "C-1@1"]);
});

test("the node budget accepts 64 nodes and refuses 65", () => {
  const chain = (count: number) => Array.from({ length: count }, (_, index) =>
    node(`C-${count - index}@1`, index === count - 1 ? [] : [`C-${count - index - 1}@1`],
      { own_ceiling: index === count - 1 ? "citation" : "computation" }));
  assert.equal(selected(fixture(chain(64))).limitingPath.length, 64);
  assert.deepEqual(fixture(chain(65)).pick(), { kind: "unavailable" });
});

test("source prose is never copied into trusted instructions, and output paths are detached", () => {
  const f = fixture();
  Object.assign(f.snapshot.closure.nodes[0]!, { statement: "UNTRUSTED source prose", row: { fellow: "UNTRUSTED" } });
  const before = JSON.stringify([...f.snapshot.assessments]); const focus = selected(f);
  assert.ok(!JSON.stringify(focus).includes("UNTRUSTED"));
  (focus.dependencyPath as string[]).push("C-99@1");
  (focus.limitingPath as string[]).push("C-98@1");
  assert.equal(JSON.stringify([...f.snapshot.assessments]), before);
});

test("a dispute cannot hide a cycle behind the calculator's earlier stopping condition", () => {
  assert.deepEqual(fixture([
    node("C-2@1", ["C-1@1"], { disposition: "disputed" }), node("C-1@1", ["C-2@1"]),
  ]).pick(), { kind: "unavailable" });
});

test("duplicate edges do not create an additional scientific dependency", () => {
  const f = fixture(); f.snapshot.closure.edges.push(f.snapshot.closure.edges[0]!);
  assert.deepEqual(f.pick(), { kind: "unavailable" });
});

test("more than sixteen direct premises cannot enter a trusted move", () => {
  const leaves = Array.from({ length: 17 }, (_, i) => node(`C-${i + 1}@1`));
  assert.deepEqual(fixture([node("C-18@1", leaves.map(n => n.target)), ...leaves]).pick(), { kind: "unavailable" });
});
