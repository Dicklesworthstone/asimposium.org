import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimGraphSummary } from "../../src/ledger/claim-graph-read.ts";
import type { ScientificDisposition } from "../../src/ledger/scientific-disposition.ts";
import { claimHonorsStatus, honorsCandidateVersion } from "../../src/discovery/honors-eligibility.ts";

// Explicit canonical-fold/graph-summary fixtures. These exercise recognition
// policy, not the scientific evaluator, source hashes, D1 or Zod decoders.
const expected = { problem: "P-DEMO", claim: "C-1", through: 20 };
function fold(patch: Partial<ScientificDisposition> = {}): ScientificDisposition {
  return {
    disposition: "strongly-supported", currentVersion: 1, stale: false, legacyReviews: 0,
    directiveDisclosure: "satisfied",
    reviewFacets: [],
    context: { recorded_refutation_attempts: 1, has_certified_artifact: true,
      verified_reviews: [{ review_id: "R-1", reviewer_id: "F-reviewer", tier: "T2",
        cross_family: true, full_write_up: true, finding: "support" }] },
    ...patch,
  };
}
function graph(): ClaimGraphSummary {
  return {
    problem: "P-DEMO", target: "C-1@1", through: 20,
    standing: { complete: true, stale: false, latest_version: 1,
      disposition: "strongly-supported", review_state: "independently-checked", own_ceiling: "certified" },
    chain: { complete: true, ceiling: "certified", reason: "weakest-evidence", weakest_path: ["C-1@1"] },
    closure: { scope: "publication-pins", complete: true, verified_premises: 0,
      recorded_edges: 0, unavailable_references: 0 },
    limiting_premise: { target: "C-1@1", standing: null, read_url: "/p/P-DEMO/claims/C-1@1.md?through=20" },
    read_url: "/p/P-DEMO/claims/C-1@1.md?through=20",
  };
}
test("a strongly-supported current certified chain can carry the machine-checked badge", () => {
  assert.equal(claimHonorsStatus(fold(), graph(), expected), "machine-checked");
});
for (const directiveDisclosure of ["missing", "unresolved", "unavailable"] as const) {
  test(`${directiveDisclosure} sponsor coverage withholds honors despite a supplied strong label`, () => {
    const value = fold({ directiveDisclosure });
    assert.equal(honorsCandidateVersion(value), null);
    assert.equal(claimHonorsStatus(value, graph(), expected), null);
  });
}
for (const disposition of ["draft", "open", "malformed", "disputed", "corroborated", "refuted", "reduced-to", "withdrawn", "superseded"] as const) {
  test(`an artifact cannot give ${disposition} honors or bypass its scientific disposition`, () => {
    const value = fold({ disposition });
    assert.equal(honorsCandidateVersion(value), null);
    assert.equal(claimHonorsStatus(value, graph(), expected), null);
  });
}
for (const currentVersion of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`an unavailable or invalid version ${currentVersion} cannot float to version one`, () => {
    assert.equal(honorsCandidateVersion(fold({ currentVersion })), null);
  });
}
test("a stale strong fold is excluded even while its historical artifact flag survives", () => {
  assert.equal(honorsCandidateVersion(fold({ stale: true })), null);
  assert.equal(claimHonorsStatus(fold({ stale: true }), graph(), expected), null);
  assert.equal(honorsCandidateVersion(undefined), null);
});
for (const ceiling of ["assertion", "heuristic", "citation", "computation"] as const) {
  test(`a ${ceiling} premise limits the machine badge without erasing independently reviewed prose`, () => {
    const value = graph();
    const limited = { ...value, chain: { ...value.chain, ceiling, weakest_path: ["C-1@1", "C-2@1"] } };
    assert.equal(claimHonorsStatus(fold(), limited, expected), "strongly-supported");
  });
}
test("a certified chain alone never manufactures an artifact or upgrades prose-proof class", () => {
  const own = fold();
  const prose = { ...own, context: { ...own.context, has_certified_artifact: false } };
  assert.equal(claimHonorsStatus(prose, graph(), expected), "strongly-supported");
  const value = graph();
  assert.equal(claimHonorsStatus(fold(), { ...value,
    standing: { ...value.standing, own_ceiling: "assertion" },
    chain: { ...value.chain, ceiling: "assertion" } }, expected), "strongly-supported");
});
for (const reason of ["source-unavailable", "dependency-history-unavailable", "dependency-cycle", "premise-not-current", "premise-contested", "premise-inactive"] as const) {
  test(`${reason} is not a dependency-free scientific success`, () => {
    const value = graph();
    assert.equal(claimHonorsStatus(fold(), { ...value,
      chain: { ...value.chain, complete: false, ceiling: null, reason } }, expected), null);
  });
}
for (const patch of [ { problem: "P-OTHER" }, { target: "C-2@1" }, { target: "C-1@2" }, { through: 21 } ]) {
  test(`cross-scope snapshot ${JSON.stringify(patch)} cannot supply recognition`, () => {
    assert.equal(claimHonorsStatus(fold(), { ...graph(), ...patch }, expected), null);
  });
}
for (const patch of [ { complete: false }, { stale: true }, { latest_version: 2 }, { disposition: "disputed" as const } ]) {
  test(`changed root standing ${JSON.stringify(patch)} defeats the earlier preliminary fold`, () => {
    const value = graph();
    assert.equal(claimHonorsStatus(fold(), { ...value, standing: { ...value.standing, ...patch } }, expected), null);
  });
}
test("partial ancestry and a null ceiling never count as successful empty ancestry", () => {
  const value = graph();
  for (const patch of [ { complete: false }, { unavailable_references: 1 } ])
    assert.equal(claimHonorsStatus(fold(), { ...value, closure: { ...value.closure, ...patch } }, expected), null);
  assert.equal(claimHonorsStatus(fold(), { ...value, chain: { ...value.chain, ceiling: null } }, expected), null);
});
test("each exact version stays pinned and the policy is pure", () => {
  const value = graph();
  const revised = { ...value, target: "C-1@2", standing: { ...value.standing, latest_version: 2 } };
  const source = fold({ currentVersion: 2 });
  const before = JSON.stringify([source, revised]);
  assert.equal(claimHonorsStatus(source, revised, expected), "machine-checked");
  assert.equal(claimHonorsStatus(source, revised, expected), "machine-checked");
  assert.equal(JSON.stringify([source, revised]), before);
});
