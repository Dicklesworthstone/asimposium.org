import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimFaceResponse } from "@asimposium/contracts";
import { buildClaimPageViewModel } from "../../lib/claim-page-view";
import { buildClaimShareCardData } from "../../lib/share-card";

function fixture() {
  const root = {
    problem: "P-CERT",
    claim_id: "C-3",
    version: 1,
    statement: "A statement with a checked formal artifact and declared premises.",
    dependency_pins: [{ claim_id: "C-2", version: 1 }],
    dependency_closure: {
      scope: "publication-pins",
      through: 42,
      scan_complete: true,
      verified_dependencies: 2,
      unavailable_dependencies: 0,
    },
    dependency_assessment: {
      scope: "publication-pins",
      problem: "P-CERT",
      target: "C-3@1",
      through: 42,
      standing: {
        complete: true,
        disposition: "strongly-supported",
        review_state: "independently-checked",
        stale: false,
        latest_version: 1,
        own_ceiling: "certified",
      },
      chain: {
        complete: true,
        ceiling: "certified",
        reason: "weakest-evidence",
        weakest_path: ["C-3@1", "C-2@1", "C-1@1"],
      },
    },
  };
  const state: ClaimFaceResponse["claim_state"] = {
    claim_id: "C-3",
    version: 1,
    latest_version: 1,
    disposition: "strongly-supported",
    review_state: "independently-checked",
    directive_disclosure: "satisfied",
    unchallenged: false,
    stale: false,
    recorded_refutation_attempts: 1,
    certified_artifact: true,
    legacy_reviews: 0,
  };
  const omitted: ClaimFaceResponse["omitted"] = [];
  const face = (): ClaimFaceResponse => ({
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    profile: "claim",
    problem: "P-CERT",
    cursor: 42,
    fingerprint: "fnv1a64:0000000000000000",
    title: "P-CERT — C-3@1",
    preamble: "Computed standing at the captured ledger cursor.",
    claim_state: state,
    items: [{
      kind: "claim-detail",
      id: "C-3@1",
      scope: "ledger",
      untrusted: true,
      why_included: "exact public statement version",
      body: JSON.stringify(root),
      neutralized: [],
    }],
    omitted,
    degraded: [],
    next_actions: [],
  });
  return { root, state, omitted, face };
}

function expectBadge(face: ClaimFaceResponse, earned: boolean): void {
  const view = buildClaimPageViewModel(face);
  const share = buildClaimShareCardData(face, face.problem);
  assert.deepEqual(view.badges.machineChecked, {
    earned,
    label: earned ? "machine-checked" : null,
  });
  assert.equal(
    share.counts.find((count) => count.label === "Machine-checked")?.value,
    earned ? "Yes" : "No",
  );
  assert.equal(view.badges.disposition, face.claim_state.disposition);
}

function replace(value: unknown, path: string, replacement: unknown): void {
  const parts = path.split(".");
  let parent = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = replacement;
}

test("page and share card award the same certified chain at its exact historical cut", () => {
  const f = fixture();
  expectBadge(f.face(), true);
  // Display budgets may omit premise bodies; the complete server assessment
  // still belongs to this exact statement and cursor.
  f.omitted.push({ reason: "budget_limit", detail: "Premise bodies omitted from this digest." });
  expectBadge(f.face(), true);
});

test("an explicitly complete certified statement without declared premises qualifies", () => {
  const f = fixture();
  f.root.dependency_pins = [];
  f.root.dependency_closure.verified_dependencies = 0;
  f.root.dependency_assessment.chain.weakest_path = ["C-3@1"];
  expectBadge(f.face(), true);
});

for (const ceiling of ["assertion", "heuristic", "citation", "computation"]) {
  test(`a certified own artifact cannot raise a ${ceiling} dependency ceiling`, () => {
    const f = fixture();
    f.root.dependency_assessment.chain.ceiling = ceiling;
    const view = buildClaimPageViewModel(f.face());
    assert.equal(view.badges.ceiling, `Evidence ceiling: ${ceiling}`);
    expectBadge(f.face(), false);
  });
}

for (const [path, value] of [
  ["problem", "P-OTHER"],
  ["claim_id", "C-9"],
  ["version", 2],
  ["dependency_assessment", undefined],
  ["dependency_assessment", []],
  ["dependency_assessment.scope", "mutable-heads"],
  ["dependency_assessment.problem", "P-OTHER"],
  ["dependency_assessment.target", "C-3@2"],
  ["dependency_assessment.through", 43],
  ["dependency_assessment.through", "42"],
  ["dependency_assessment.standing.complete", false],
  ["dependency_assessment.standing.stale", true],
  ["dependency_assessment.standing.latest_version", 2],
  ["dependency_assessment.standing.own_ceiling", "computation"],
  ["dependency_assessment.standing.disposition", "open"],
  ["dependency_assessment.standing.review_state", "unreviewed"],
  ["dependency_assessment.standing.review_state", "contested"],
  ["dependency_assessment.chain.complete", false],
  ["dependency_assessment.chain.reason", "source-unavailable"],
  ["dependency_assessment.chain.ceiling", null],
  ["dependency_assessment.chain.weakest_path", ["C-9@1"]],
  ["dependency_assessment.chain.weakest_path", ["C-3@1", "C-2@1", "C-1@1", "C-4@1"]],
  ["dependency_closure", undefined],
  ["dependency_closure.through", 43],
  ["dependency_closure.scan_complete", false],
  ["dependency_closure.unavailable_dependencies", 1],
  ["dependency_closure.verified_dependencies", 1],
  ["dependency_pins", undefined],
] as const) {
  test(`incomplete or contradictory root metadata cannot certify: ${path}=${JSON.stringify(value)}`, () => {
    const f = fixture();
    replace(f.root, path, value);
    expectBadge(f.face(), false);
  });
}

for (const reason of ["dependency_history_unavailable", "premise_assessment_unavailable"]) {
  test(`an explicit ${reason} omission overrides a favorable assessment`, () => {
    const f = fixture();
    f.omitted.push({ reason, detail: "The complete scientific chain is unavailable." });
    expectBadge(f.face(), false);
  });
}

for (const [path, value] of [
  ["certified_artifact", false],
  ["disposition", "corroborated"],
  ["disposition", "refuted"],
  ["stale", true],
  ["review_state", "contested"],
  ["latest_version", 2],
  ["directive_disclosure", "missing"],
  ["directive_disclosure", "unresolved"],
  ["directive_disclosure", "unavailable"],
] as const) {
  test(`a certified chain cannot override the claim's own ${path}=${value}`, () => {
    const f = fixture();
    replace(f.state, path, value);
    expectBadge(f.face(), false);
  });
}

test("missing claim detail does not let a recorded artifact imply a certified chain", () => {
  expectBadge({ ...fixture().face(), items: [] }, false);
});

test("a complete-looking old statement cannot borrow its successor's standing", () => {
  const f = fixture();
  f.state.latest_version = 2;
  f.root.dependency_assessment.standing.latest_version = 2;
  expectBadge(f.face(), false);
});
