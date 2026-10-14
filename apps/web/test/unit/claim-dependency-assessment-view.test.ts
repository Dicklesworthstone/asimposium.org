import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimFaceResponse } from "@asimposium/contracts";
import { buildClaimPageViewModel } from "../../lib/claim-page-view";

function assessment(target = "C-3@1") {
  return {
    scope: "publication-pins", problem: "P-VIEW", target, through: 9,
    standing: { complete: true, disposition: "open", review_state: "unreviewed",
      stale: false, latest_version: 1, own_ceiling: "computation" },
    chain: { complete: true, ceiling: "citation", reason: "weakest-evidence",
      weakest_path: target === "C-3@1" ? ["C-3@1", "C-2@1", "C-1@1"] : [target] },
  };
}
function fixture() {
  const root = {
    problem: "P-VIEW", claim_id: "C-3", version: 1, statement: "A proposition with declared premises.",
    dependency_pins: [{ claim_id: "C-2", version: 1 }],
    dependency_closure: { scope: "publication-pins", through: 9, scan_complete: true,
      verified_dependencies: 2, unavailable_dependencies: 0 },
    dependency_assessment: assessment(),
  };
  const leaf = {
    problem: "P-VIEW", claim_id: "C-1", version: 1, statement: "The limiting premise.",
    dependency_depth: 2, dependency_path: ["C-3@1", "C-2@1", "C-1@1"],
    dependency_assessment: assessment("C-1@1"),
  };
  const omitted: { reason: string; detail: string }[] = [];
  const state = { claim_id: "C-3", version: 1, latest_version: 1, disposition: "open",
    review_state: "unreviewed", unchallenged: true, stale: false,
    recorded_refutation_attempts: 0, certified_artifact: false, legacy_reviews: 0 };
  const face = () => ({ problem: "P-VIEW", cursor: 9, claim_state: state,
    items: [{ kind: "claim-detail", id: "C-3@1", body: JSON.stringify(root) },
      { kind: "claim-dependency", id: "C-1@1", body: JSON.stringify(leaf) }],
    omitted, degraded: [], next_actions: [],
  }) as unknown as ClaimFaceResponse;
  return { root, leaf, omitted, state, view: () => buildClaimPageViewModel(face()) };
}

test("the human view exposes the canonical weakest ceiling and exact limiting path", () => {
  const f = fixture(), view = f.view();
  assert.equal(view.badges.ceiling, "Evidence ceiling: citation");
  assert.equal(view.badges.disposition, "open");
  assert.equal(view.badges.machineChecked.earned, false);
  const gap = view.whatRemainsUnverified.gaps.find(g => g.code === "DEPENDENCY_EVIDENCE_CEILING")!;
  assert.match(gap.detail, /C-3@1 → C-2@1 → C-1@1/);
  assert.match(gap.detail, /not a truth verdict/);
  assert.equal(view.dependencies[0]?.assessment?.ownCeiling, "computation");
  assert.equal(view.dependencies[0]?.assessment?.ceiling, "citation");
  assert.equal(view.dependencies[0]?.href, "/p/P-VIEW/claims/C-1%401?through=9");
  assert.ok(view.whatRemainsUnverified.gaps.some(g=>g.code==='DEPENDENCIES_NOT_SHOWN'));
});

for (const ceiling of ["assertion", "heuristic", "citation", "computation", "certified"]) {
  test(`${ceiling} is evidence metadata, never an automatic disposition or machine-check upgrade`, () => {
    const f = fixture(); f.root.dependency_assessment.standing.own_ceiling = ceiling;
    f.root.dependency_assessment.chain.ceiling = ceiling;
    assert.equal(f.view().badges.ceiling, `Evidence ceiling: ${ceiling}`);
    assert.equal(f.view().badges.disposition, "open");
    assert.equal(f.view().badges.machineChecked.earned, false);
  });
}

const mutate = (value: unknown, path: string, replacement: unknown) => {
  const parts = path.split("."); let parent = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = replacement;
};
for (const [path, value] of [
  ["scope", "mutable-heads"], ["problem", "P-FOREIGN"], ["target", "C-3@2"], ["through", 10],
  ["standing.complete", false], ["standing.stale", true], ["standing.disposition", "refuted"],
  ["standing.disposition", "PROVED"], ["standing.review_state", "contested"],
  ["standing.latest_version", 2], ["standing.latest_version", null],
  ["standing.own_ceiling", "assertion"], ["chain.ceiling", "infinity"], ["chain.ceiling", null],
  ["chain.reason", "source-unavailable"], ["chain.weakest_path", []],
  ["chain.weakest_path", ["C-FOREIGN@1"]], ["chain.weakest_path", ["C-3@1", "javascript:alert(1)"]],
  ["chain.weakest_path", ["C-3@1", "C-2@9007199254740992"]],
  ["chain.weakest_path", ["C-3@1", "C-3@2"]],
  ["chain.weakest_path", ["C-3@1", "C-2@1", "C-1@1", "C-4@1"]],
  ["chain", []], ["standing", []],
] as const) {
  test(`malformed or contradictory assessment falls back without favorable evidence: ${path}=${JSON.stringify(value)}`, () => {
    const f = fixture(); mutate(f.root.dependency_assessment, path, value);
    assert.doesNotMatch(f.view().badges.ceiling, /^Evidence ceiling:/);
    assert.ok(!f.view().whatRemainsUnverified.gaps.some(g=>g.code==='DEPENDENCY_EVIDENCE_CEILING'));
  });
}

for (const reason of ["premise-inactive", "premise-contested", "premise-not-current", "source-unavailable", "dependency-history-unavailable", "dependency-cycle"]) {
  test(`unknown chain exposes ${reason} instead of a positive ceiling`, () => {
    const f = fixture();
    mutate(f.root.dependency_assessment, "chain", {complete:false,ceiling:null,reason,weakest_path:["C-3@1","C-2@1","C-1@1"]});
    assert.equal(f.view().badges.ceiling, `Evidence ceiling unavailable · ${reason}`);
    assert.equal(f.view().badges.disposition, "open");
    const gap=f.view().whatRemainsUnverified.gaps.find(g=>g.code==='DEPENDENCY_ASSESSMENT_UNAVAILABLE')!;
    assert.match(gap.detail,/C-1@1/);
    assert.equal(gap.severity, reason.startsWith('premise-') ? 'critical' : 'warning');
  });
}

test("a disputed premise is displayed from its own pinned assessment", () => {
  const f=fixture(); f.leaf.dependency_assessment.standing.disposition='disputed';
  mutate(f.leaf.dependency_assessment,'chain',{complete:false,ceiling:null,reason:'premise-contested',weakest_path:['C-1@1']});
  const view=f.view();
  assert.equal(view.dependencies[0]?.assessment?.disposition,'disputed');
  assert.equal(view.dependencies[0]?.isDisputed,true);
  assert.ok(view.whatRemainsUnverified.gaps.some(g=>g.code==='DISPUTED_PREMISE'));
});

test("unknown source fields remain unknown, never clean or unconditional", () => {
  const f=fixture(); mutate(f.root.dependency_assessment,'standing',{
    complete:false,disposition:null,review_state:null,stale:true,latest_version:null,own_ceiling:null,
  });
  mutate(f.root.dependency_assessment,'chain',{complete:false,ceiling:null,reason:'source-unavailable',weakest_path:['C-3@1']});
  assert.match(f.view().badges.ceiling,/unavailable/);
  assert.doesNotMatch(f.view().badges.ceiling,/unconditional|certified/);
});

test("explicit incompleteness overrides a contradictory favorable summary", () => {
  const f=fixture(); f.omitted.push({reason:'premise_assessment_unavailable',detail:'source'});
  assert.doesNotMatch(f.view().badges.ceiling,/^Evidence ceiling:/);
  f.omitted.splice(0); f.root.dependency_closure.scan_complete=false;
  assert.doesNotMatch(f.view().badges.ceiling,/^Evidence ceiling:/);
});

test("a foreign or malformed premise path cannot lend an assessment to a displayed node", () => {
  const f=fixture(); f.leaf.problem='P-OTHER';
  assert.equal(f.view().dependencies[0]?.assessment,undefined);
  f.leaf.problem='P-VIEW'; f.leaf.dependency_path=['C-9@1','C-2@1','C-1@1'];
  assert.equal(f.view().dependencies[0]?.assessment,undefined);
});

test("old faces retain their structural fallback and public statuses", () => {
  const f=fixture(); mutate(f.root,'dependency_assessment',undefined); mutate(f.leaf,'dependency_assessment',undefined);
  const view=f.view(); assert.match(view.badges.ceiling,/uncomputed/);
  assert.equal(view.dependencies[0]?.assessment,undefined);
  assert.equal(view.badges.disposition,'open');
});
