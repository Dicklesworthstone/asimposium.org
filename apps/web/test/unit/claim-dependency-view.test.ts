import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimFaceResponse } from "@asimposium/contracts";
import { buildClaimPageViewModel } from "../../lib/claim-page-view";

// These are view-model inputs, not a substitute for canonical contract fixtures.
function fixture() {
  const root: Record<string, unknown> = {
    problem: "P-VIEW", claim_id: "C-3", version: 1, kind: "lemma",
    statement: "The exact root proposition.", dependency_pins: [],
    dependency_closure: {
      scope: "publication-pins", through: 3, scan_complete: true,
      verified_dependencies: 0, unavailable_dependencies: 0,
    },
  };
  const dependencies: Record<string, unknown>[] = [];
  const omitted: { reason: string; detail: string }[] = [];
  const state = {
    claim_id: "C-3", version: 1, latest_version: 1, disposition: "open",
    review_state: "unreviewed", unchallenged: true, stale: false,
    recorded_refutation_attempts: 0, certified_artifact: false, legacy_reviews: 0,
  };
  const face = () => ({
    problem: "P-VIEW", cursor: 3, claim_state: state,
    items: [{ kind: "claim-detail", id: "C-3@1", body: JSON.stringify(root) },
      ...dependencies.map((dependency) => ({ kind: "claim-dependency",
        id: `${dependency.claim_id}@${dependency.version}`, body: JSON.stringify(dependency) }))],
    omitted, degraded: [], next_actions: [],
  }) as unknown as ClaimFaceResponse;
  const view = () => buildClaimPageViewModel(face());
  const chain = () => {
    root.dependency_pins = [{ claim_id: "C-2", version: 1 }];
    root.dependency_closure = {
      scope: "publication-pins", through: 3, scan_complete: true,
      verified_dependencies: 2, unavailable_dependencies: 0,
    };
    dependencies.push(
      { claim_id: "C-2", version: 1, statement: "Direct premise.",
        dependency_depth: 1, dependency_path: ["C-3@1", "C-2@1"] },
      { claim_id: "C-1", version: 1, statement: "Transitive premise.",
        dependency_depth: 2, dependency_path: ["C-3@1", "C-2@1", "C-1@1"] },
    );
  };
  return { root, dependencies, omitted, state, face, view, chain };
}
function incomplete(view: ReturnType<typeof buildClaimPageViewModel>) {
  assert.match(view.badges.ceiling, /incomplete/);
  assert.ok(view.whatRemainsUnverified.gaps.some((gap) => gap.code === "DEPENDENCY_HISTORY_UNAVAILABLE"));
  assert.doesNotMatch(view.badges.ceiling, /unconditional|No declared premises/);
}

test("an explicitly empty verified dependency history says only no declared premises", () => {
  const f = fixture();
  assert.equal(f.view().badges.ceiling, "No declared premises");
  assert.equal(f.view().dependencies.length, 0);
  assert.equal(f.view().badges.disposition, "open");
  assert.equal(f.view().badges.machineChecked.earned, false);
});

test("direct and transitive paths are distinct and keep the same cursor in links", () => {
  const f = fixture(); f.chain(); const view = f.view();
  assert.equal(view.badges.ceiling, "2 of 2 declared premise(s) shown · evidence ceiling uncomputed");
  assert.deepEqual(view.dependencies.map((d) => [d.depth, d.path]), [
    [1, ["C-3@1", "C-2@1"]], [2, ["C-3@1", "C-2@1", "C-1@1"]],
  ]);
  assert.equal(view.dependencies[1]?.href, "/p/P-VIEW/claims/C-1%401?through=3");
  assert.equal(view.badges.disposition, "open");
  assert.equal(view.dependencies[1]?.isDisputed, false);
  assert.match(view.whatRemainsUnverified.gaps.find((g) => g.code === "PREMISE_BOUNDED")?.detail ?? "", /does not compute/);
});

test("a complete scan is not a promise that the budgeted view displays every dependency", () => {
  const f = fixture(); f.chain(); f.dependencies.pop();
  assert.equal(f.view().badges.ceiling, "1 of 2 declared premise(s) shown · evidence ceiling uncomputed");
  assert.ok(f.view().whatRemainsUnverified.gaps.some((g) => g.code === "DEPENDENCIES_NOT_SHOWN"));
});

test("no displayed records is not unconditional when all premises were omitted", () => {
  const f = fixture(); f.chain(); f.dependencies.length = 0;
  assert.equal(f.view().badges.ceiling, "0 of 2 declared premise(s) shown · evidence ceiling uncomputed");
});

for (const history of [undefined, null, [], "complete", {}, { scan_complete: "true" }]) {
  test(`missing or malformed closure metadata remains unknown: ${JSON.stringify(history)}`, () => {
    const f = fixture(); f.root.dependency_closure = history; incomplete(f.view());
  });
}

for (const [field, value] of [
  ["scope", "mutable-heads"], ["through", 4], ["through", "3"],
  ["scan_complete", false], ["scan_complete", 1], ["scan_complete", "true"],
  ["verified_dependencies", -1], ["verified_dependencies", 64],
  ["verified_dependencies", 0.5], ["verified_dependencies", "0"],
  ["unavailable_dependencies", 1], ["unavailable_dependencies", "0"],
] as const) {
  test(`invalid ${field} cannot imply complete dependency history (${JSON.stringify(value)})`, () => {
    const f = fixture();
    f.root.dependency_closure = { ...(f.root.dependency_closure as object), [field]: value };
    incomplete(f.view());
  });
}

for (const [field, value] of [["problem", "P-OTHER"], ["claim_id", "C-9"], ["version", 2]] as const) {
  test(`closure summary must belong to the exact displayed ${field}`, () => {
    const f = fixture(); f.root[field] = value; incomplete(f.view());
  });
}

test("an explicit missing-history omission wins over a superficially complete summary", () => {
  const f = fixture(); f.omitted.push({ reason: "dependency_history_unavailable", detail: "C-3@1" });
  incomplete(f.view());
});

test("nonempty pins cannot agree with a zero dependency count", () => {
  const f = fixture(); f.root.dependency_pins = [{ claim_id: "C-2" }]; incomplete(f.view());
});

test("an empty pin list cannot agree with a nonempty dependency count", () => {
  const f = fixture(); f.chain(); f.root.dependency_pins = []; incomplete(f.view());
});

test("a scan count cannot be smaller than the displayed dependency set", () => {
  const f = fixture(); f.chain();
  f.root.dependency_closure = { ...(f.root.dependency_closure as object), verified_dependencies: 1 };
  incomplete(f.view());
});

test("duplicate displayed premises do not inflate completeness", () => {
  const f = fixture(); f.chain(); f.dependencies[1] = { ...f.dependencies[0] };
  incomplete(f.view());
});

for (const [depth, path] of [
  [undefined, undefined], [0, ["C-3@1"]], [2, ["C-3@1", "C-2@1"]],
  ["1", ["C-3@1", "C-2@1"]], [1, "C-3@1 → C-2@1"],
  [1, ["C-9@1", "C-2@1"]], [1, ["C-3@1", "C-1@1"]],
  [2, ["C-3@1", 99, "C-2@1"]],
  [2, ["C-3@1", "C-3@2", "C-2@1"]],
  [2, ["C-3@1", "C-1@1\n", "C-2@1"]],
  [2, ["C-3@1", "C-1@9007199254740992", "C-2@1"]],
  [64, new Array(65).fill("C-3@1")],
] as const) {
  test(`invalid dependency path is unavailable, not mislabelled direct: ${JSON.stringify([depth, path])}`, () => {
    const f = fixture(); f.chain();
    Object.assign(f.dependencies[0]!, { dependency_depth: depth, dependency_path: path });
    const view = f.view();
    assert.equal(view.dependencies[0]?.depth, undefined);
    assert.equal(view.dependencies[0]?.path, undefined);
    incomplete(view);
  });
}

test("missing author detail cannot establish an empty dependency history", () => {
  const f = fixture(); const face = { ...f.face(), items: [] };
  incomplete(buildClaimPageViewModel(face));
});

test("dependency metadata cannot mint machine-checked status or alter scientific disposition", () => {
  const f = fixture(); f.chain();
  f.root.dependency_closure = { ...(f.root.dependency_closure as object), certified_artifact: true, disposition: "strongly-supported" };
  assert.equal(f.view().badges.machineChecked.earned, false);
  assert.equal(f.view().badges.disposition, "open");
  f.state.certified_artifact = true;
  assert.equal(f.view().badges.machineChecked.earned, true);
});

test("the Worker staleness facet is preserved independently of structural completeness", () => {
  const f = fixture(); f.chain(); f.state.stale = true;
  assert.equal(f.view().badges.staleness.isStale, true);
  assert.match(f.view().badges.ceiling, /evidence ceiling uncomputed/);
});
