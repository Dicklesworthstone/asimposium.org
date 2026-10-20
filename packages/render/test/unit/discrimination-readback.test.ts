import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HypothesisEvidenceItemResponse } from "@asimposium/contracts";
import type { DiscriminationReport } from "@asimposium/contracts/discrimination";
import { stableStringify } from "../../src/canonical.ts";
import { renderHypothesisEvidenceHtml } from "../../src/hypothesis-evidence.ts";
import {
  DISCRIMINATION_READBACK_BOUNDARY,
  DISCRIMINATION_READBACK_MAX_BYTES,
  discriminationReadback,
} from "../../src/discrimination.ts";

function fixture() {
  const report: DiscriminationReport = {
    format: "asimposium.discrimination.v1", problem_id: "P-1",
    kind: "computation", source: { kind: "locator", locator: "https://example.test/experiment", excerpt: "Observed zero at the shared boundary." },
    mode: "exploratory", computation_domain_or_floor: "One boundary input; exact integer arithmetic.",
    reproduction: { commands: ["run boundary-check", "read results"], environment: "fixed integer reference implementation", seed: "42" },
    work: {
      question: "Which route predicts the boundary observation?",
      protocol: "Evaluate the same scalar observable at the specified boundary input for each route.",
      observation: "The observed value was zero.", limitations: "A single boundary input does not establish a global theorem.",
      prediction_timing_self_declared: "before-observation",
      cases: [
        { hypothesis_id: "H-1", prediction: "Zero", would_count_against: "Any nonzero value", direction: "supports", interpretation: "Consistent on this input only." },
        { hypothesis_id: "H-2", prediction: "Strictly positive", would_count_against: "A nonpositive value", direction: "refutes", interpretation: "Conflicts with this prediction." },
      ],
    },
  };
  const face: HypothesisEvidenceItemResponse = {
    schema: "asimposium.hypothesis-evidence.v1", problem_id: "P-1", cursor: 20,
    evidence_id: "E-1", bears_on: { kind: "hypothesis", id: "H-1" },
    publication: { event_id: "EV-1", seq: 15, payload_sha256: "a".repeat(64), created_at: "2026-10-12T00:00:00.000Z", fellow_id: "F-1", sponsor_id: "SP-1", session_id: "SE-1", model_self_declared: "model", harness_self_declared: "harness" },
    withdrawn: false,
    content: { bears_on_kind: "hypothesis", bears_on_id: "H-1", direction: "supports", kind: report.kind, mode: report.mode, source: { ...report.source }, reproduction: structuredClone(report.reproduction), computation_domain_or_floor: report.computation_domain_or_floor, body_md: JSON.stringify(report) },
    computed: { computed_class: "computation", coercion_flags: [], drives_promotion: false },
    omitted: ["item_face_scope"],
  };
  return { face, report };
}
function refreshBody(f: ReturnType<typeof fixture>) {
  f.face.content!.body_md = JSON.stringify(f.report);
}

test("human evidence decodes the bound experiment with separate predictions and no inferred publications", () => {
  const { face } = fixture();
  const html = renderHypothesisEvidenceHtml(face);
  expectText(html, "Reported experiment comparison", "<h3>Observation</h3>", "<h3>Would count against</h3>",
    "Strictly positive", "A nonpositive value", "before-observation", "H-2 — comparison declared in the report");
  assert.ok(html.includes(DISCRIMINATION_READBACK_BOUNDARY));
  assert.ok(!html.includes('href="/r/p/P-1/evidence/E-2"'));
  face.content!.direction = "refutes";
  const mismatch = renderHypothesisEvidenceHtml(face);
  assert.ok(!mismatch.includes("<h3>Reported experiment comparison</h3>"));
  assert.ok(mismatch.includes("could not be bound unchanged"));
  assert.ok(mismatch.includes("Published scientific body"));
});

function expectText(html: string, ...texts: string[]) {
  for (const text of texts) assert.ok(html.includes(text), text);
}

test("decoded experiment view retains observation, protocol, falsifiers and contrasting interpretations", () => {
  const { face, report } = fixture();
  const view = discriminationReadback(face, report);
  assert.ok(view);
  assert.equal(view.observation, report.work.observation);
  assert.equal(view.protocol, report.work.protocol);
  assert.equal(view.limitations, report.work.limitations);
  assert.equal(view.question, report.work.question);
  assert.equal(view.prediction_timing_self_declared, "before-observation");
  assert.equal(view.observation_mode, "exploratory");
  assert.equal(view.publication.evidence_id, "E-1");
  assert.equal(view.publication.event_id, "EV-1");
  assert.equal(view.publication.payload_sha256, face.publication.payload_sha256);
  assert.deepEqual(view.comparisons.map(x => x.is_this_evidence_target), [true, false]);
  assert.deepEqual(view.comparisons.map(x => x.direction_reported_by_author), ["supports", "refutes"]);
  assert.equal(view.comparisons[1]?.would_count_against, "A nonpositive value");
  assert.deepEqual(view.reproduction, report.reproduction);
  assert.deepEqual(view.source, report.source);
});
test("one report never invents evidence IDs or publication status for its other comparison rows", () => {
  const { face, report } = fixture();
  const view = discriminationReadback(face, report);
  assert.ok(view);
  for (const row of view.comparisons) {
    assert.equal("evidence_id" in row, false);
    assert.equal("publication" in row, false);
    assert.equal("current_status" in row, false);
    assert.equal("verified" in row, false);
  }
  assert.ok(DISCRIMINATION_READBACK_BOUNDARY.includes("not independent replications"));
  assert.ok(DISCRIMINATION_READBACK_BOUNDARY.includes("not proof of separate publications"));
});
test("same experiment body can be read coherently from either target's ordinary evidence item", () => {
  const { face, report } = fixture();
  face.evidence_id = "E-2";
  face.bears_on.id = "H-2";
  face.content!.bears_on_id = "H-2";
  face.content!.direction = "refutes";
  const view = discriminationReadback(face, report);
  assert.ok(view);
  assert.equal(view.publication.evidence_id, "E-2");
  assert.deepEqual(view.comparisons.map(x => x.is_this_evidence_target), [false, true]);
});
test("withdrawn evidence stays legible as a withdrawn historical report, never renewed support", () => {
  const { face, report } = fixture(); face.withdrawn = true;
  const view = discriminationReadback(face, report);
  assert.ok(view); assert.equal(view.publication.withdrawn, true);
  assert.equal("drives_promotion" in view, false);
});
test("retrospective timing and hypothesis selection are explicit self-declarations", () => {
  const f = fixture();
  f.report.work.prediction_timing_self_declared = "after-observation";
  f.report.selected_hypothesis_id = "H-2";
  f.face.content!.selected_hypothesis_id = "H-2";
  refreshBody(f);
  const view = discriminationReadback(f.face, f.report);
  assert.ok(view);
  assert.equal(view.prediction_timing_self_declared, "after-observation");
  assert.equal(view.selected_hypothesis_id, "H-2");
});
test("optional reproduction and computation floor are not fabricated when absent", () => {
  const f = fixture();
  delete f.report.reproduction; delete f.face.content!.reproduction;
  delete f.report.computation_domain_or_floor; delete f.face.content!.computation_domain_or_floor;
  refreshBody(f);
  const view = discriminationReadback(f.face, f.report);
  assert.ok(view); assert.equal(view.reproduction, null); assert.equal(view.computation_domain_or_floor, null);
});
test("input key order does not affect binding or canonical view bytes", () => {
  const f = fixture();
  const expected = stableStringify(discriminationReadback(f.face, f.report));
  f.face.content!.body_md = stableStringify(f.report);
  f.face.content!.reproduction = { seed: "42", environment: "fixed integer reference implementation", commands: ["run boundary-check", "read results"] };
  assert.equal(stableStringify(discriminationReadback(f.face, f.report)), expected);
});
test("the view does not mutate or alias mutable nested input fields", () => {
  const f = fixture(); const before = stableStringify(f);
  const view = discriminationReadback(f.face, f.report); assert.ok(view);
  view.comparisons[0]!.prediction = "changed view only";
  view.source.locator = "https://example.test/changed";
  view.reproduction!.commands.push("changed view only");
  assert.equal(stableStringify(f), before);
});
const mismatches: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["another problem", f => { f.face.problem_id = "P-2"; }],
  ["another target", f => { f.face.bears_on.id = "H-3"; f.face.content!.bears_on_id = "H-3"; }],
  ["payload target disagrees with envelope", f => { f.face.content!.bears_on_id = "H-2"; }],
  ["another evidence direction", f => { f.face.content!.direction = "refutes"; }],
  ["another evidence kind", f => { f.face.content!.kind = "argument"; }],
  ["another observation mode", f => { f.face.content!.mode = "confirmatory"; }],
  ["source kind changed", f => { f.face.content!.source.kind = "model_memory"; }],
  ["source locator changed", f => { f.face.content!.source.locator = "https://example.test/other"; }],
  ["source excerpt changed", f => { f.face.content!.source.excerpt = "An unrelated observation."; }],
  ["selection changed", f => { f.face.content!.selected_hypothesis_id = "H-2"; }],
  ["computation domain changed", f => { f.face.content!.computation_domain_or_floor = "Another regime"; }],
  ["reproduction missing", f => { delete f.face.content!.reproduction; }],
  ["reproduction environment changed", f => { f.face.content!.reproduction!.environment = "Another toolchain"; }],
  ["reproduction seed changed", f => { f.face.content!.reproduction!.seed = "43"; }],
  ["reproduction commands reordered", f => { f.face.content!.reproduction!.commands.reverse(); }],
  ["reproduction command missing", f => { f.face.content!.reproduction!.commands.pop(); }],
  ["different report body", f => { f.face.content!.body_md = JSON.stringify({ ...f.report, work: { ...f.report.work, observation: "A different observation" } }); }],
  ["non-JSON body", f => { f.face.content!.body_md = "plain prose"; }],
  ["null JSON body", f => { f.face.content!.body_md = "null"; }],
  ["oversized body", f => { f.face.content!.body_md = " ".repeat(65537); }],
  ["withheld content", f => { f.face.content = null; }],
  ["unavailable classification", f => { f.face.computed = null; }],
];
for (const [name, mutate] of mismatches) test(`incoherent experiment readback is not inferred: ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(discriminationReadback(f.face, f.report), null);
});
test("a missing decoded report does not turn ordinary evidence into an experiment", () => {
  const f = fixture(); assert.equal(discriminationReadback(f.face, null), null);
});
test("duplicate target cases cannot choose whichever interpretation happens to be first", () => {
  const f = fixture(); f.report.work.cases.push({ ...f.report.work.cases[0]! }); refreshBody(f);
  assert.equal(discriminationReadback(f.face, f.report), null);
});
test("reordering comparison rows without changing the published body is a different report", () => {
  const f = fixture(); f.report.work.cases.reverse();
  assert.equal(discriminationReadback(f.face, f.report), null);
});
test("ordinary-sized eight-route work remains within the optional comparison display budget", () => {
  const f = fixture();
  for (let i=3; i<=8; i++) f.report.work.cases.push({ hypothesis_id: `H-${i}`, prediction: `Outcome ${i}`, would_count_against: "Any other result", direction: "informs", interpretation: "Not resolved by this observation." });
  refreshBody(f);
  const view = discriminationReadback(f.face, f.report); assert.ok(view);
  assert.equal(view.comparisons.length, 8);
  assert.ok(new TextEncoder().encode(stableStringify(view, 2)).byteLength < DISCRIMINATION_READBACK_MAX_BYTES);
});
