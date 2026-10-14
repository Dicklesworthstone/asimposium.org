import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  composePack, composePackWithLegacyEstimatorForTest, PackComposerError,
  type PackCandidate, type PackComposerInput,
} from "../../src/pack-composer.ts";

const legacy = { reason: "profile_section_not_composed", detail: "weakest-link-paths" };
const declaration = { profile: "claim-graph", name: "weakest-link-paths" };
function candidate(overrides: Partial<PackCandidate> = {}): PackCandidate {
  return { kind: "standing-context", id: "SYS-graph", scope: "system", untrusted: false,
    body: "Graph selection is bounded; scientific and budget omissions remain explicit.",
    tokens: 1, stable_prefix: 0, why_included: "state the actual graph-section availability",
    composed_section: declaration, ...overrides };
}
function input(candidates: PackCandidate[] = [candidate()]): PackComposerInput {
  return { schema: "asimposium.pack.v1", session: "S-TEST", problem: "P-TEST", profile: "claim-graph",
    cursor: 12, requested_max_tokens: 4000,
    viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
    candidates, action_candidates: [], omitted: [legacy] };
}
const hasLegacy = (pack: ReturnType<typeof composePack>) => pack.omitted.some(o =>
  o.reason === legacy.reason && o.detail === legacy.detail);

test("server section metadata supersedes only the obsolete not-composed notice", () => {
  const pack = composePack(input());
  assert.equal(hasLegacy(pack), false); assert.equal(pack.items.length, 1);
  assert.ok(!Object.hasOwn(pack.items[0]!, "composed_section"));
  assert.ok(!pack.canonical_json.includes("composed_section"));
});

test("scientific, candidate and content omissions survive a composed section declaration", () => {
  const source = input();
  const remaining = [
    { reason: "premise_assessment_unavailable", detail: "C-1@1" },
    { reason: "candidate_limit", detail: "claim-graph" },
    { reason: "content_unavailable", detail: "weakest-link-paths" },
    { reason: "profile_section_not_composed", detail: "other-section" },
  ];
  const pack = composePack({ ...source, omitted: [legacy, ...remaining] });
  assert.equal(hasLegacy(pack), false);
  for (const entry of remaining) assert.ok(pack.omitted.some(o => o.reason === entry.reason && o.detail === entry.detail));
});

test("no declaration and a different profile do not suppress existing notices", () => {
  assert.equal(hasLegacy(composePack(input([candidate({ composed_section: undefined })]))), true);
  assert.equal(hasLegacy(composePack({ ...input(), profile: "claim" })), true);
  assert.equal(hasLegacy(composePack(input([candidate({ composed_section: { profile: "claim-graph", name: "other-section" } })]))), true);
});

test("permissions are resolved before a section may supersede a notice", () => {
  const source = input([candidate({ requires: ["graph:read"] })]);
  const denied = composePack(source);
  assert.equal(hasLegacy(denied), true); assert.equal(denied.items.length, 0);
  assert.ok(denied.omitted.some(o => o.reason === "item_permission_filtered"));
  const allowed = composePack({ ...source, viewer: { ...source.viewer, effective_permissions: ["graph:read"] } });
  assert.equal(hasLegacy(allowed), false);
});

test("no membership never consults section declarations or scientific bodies", () => {
  const source = input([candidate({ composed_section: null as never })]);
  const pack = composePack({ ...source, viewer: { ...source.viewer, membership: "none" } });
  assert.deepEqual(pack.omitted, [{ reason: "no_membership" }]); assert.equal(pack.items.length, 0);
});

test("public workshop data cannot alter section availability, even with malformed declarations", () => {
  const source = { ...input([]), viewer: { audience: "public", membership: "none", effective_permissions: [] } } as PackComposerInput;
  const baseline = composePack(source);
  const privateCandidate = candidate({ scope: "workshop", untrusted: true, composed_section: null as never });
  assert.deepEqual(composePack({ ...source, candidates: [privateCandidate] }), baseline);
});

test("anonymous claimed permissions cannot enable a restricted section declaration", () => {
  const source = input([candidate({ requires: ["graph:read"] })]);
  const pack = composePack({ ...source, viewer: { audience: "public", membership: "steward", effective_permissions: ["graph:read"] } });
  assert.equal(hasLegacy(pack), true); assert.equal(pack.items.length, 0);
});

for (const patch of [
  { scope: "ledger", untrusted: true }, { scope: "workshop", untrusted: true },
  { kind: "move" }, { kind: "claim-graph-path" },
]) {
  test(`only a trusted standing-context can declare a section: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => composePack(input([candidate(patch as Partial<PackCandidate>)])), PackComposerError);
  });
}

for (const value of [null, [], true, "weakest-link-paths", {}, { profile: "claim-graph" },
  { ...declaration, name: "" }, { ...declaration, name: "x\n" }, { ...declaration, profile: "claim-graph\n" },
  { ...declaration, name: "x".repeat(65) }, { ...declaration, status: "certified" }]) {
  test(`malformed declaration cannot suppress omissions: ${JSON.stringify(value)}`, () => {
    assert.throws(() => composePack(input([candidate({ composed_section: value as never })])), PackComposerError);
  });
}

test("source-body text cannot declare availability", () => {
  const source = candidate({ scope: "ledger", untrusted: true, composed_section: undefined,
    body: JSON.stringify({ composed_section: declaration }) });
  assert.equal(hasLegacy(composePack(input([source]))), true);
});

test("bad omission records still refuse instead of being filtered out before validation", () => {
  assert.throws(() => composePack({ ...input(), omitted: [{ ...legacy, status: "certified" } as never] }), PackComposerError);
});

test("a composed section can still be absent from a small budget; that is budget omission, not missing implementation", () => {
  const source = input([candidate({ body: "Bounded section. ".repeat(800) })]);
  const pack = composePack({ ...source, requested_max_tokens: 800 });
  assert.equal(pack.items.length, 0); assert.equal(hasLegacy(pack), false);
  assert.ok(pack.omitted.some(o => o.reason === "budget_exceeded"));
  assert.ok(pack.tokens_estimate <= 800);
});

test("section normalization is deterministic, preserves the input, and matches both budget estimators", () => {
  const source = input([candidate(), { kind: "claim-graph-path", id: "GRAPH-1", scope: "ledger", untrusted: true,
    tokens: 1, stable_prefix: 1, body: '{"target":"C-1@1","ceiling":null}', why_included: "read the current assessment" }]);
  const before = JSON.stringify(source);
  for (const requested_max_tokens of [800, 1500, 2500, 4000, 8000]) {
    const configured = { ...source, requested_max_tokens };
    assert.deepEqual(composePack(configured), composePackWithLegacyEstimatorForTest(configured));
    assert.deepEqual(composePack(configured), composePack(configured));
  }
  assert.equal(JSON.stringify(source), before);
});

test("declaring composition is equivalent to removing only its obsolete notice at the caller", () => {
  const withDeclaration = composePack(input());
  const withoutDeclaration = composePack({ ...input([candidate({ composed_section: undefined })]), omitted: [] });
  assert.deepEqual(withDeclaration, withoutDeclaration);
});
