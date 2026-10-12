import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DISCRIMINATION_FORMAT,
  discriminationIssues,
  discriminationMembers,
} from "../../src/discrimination-model.ts";
import type { DiscriminationRequest } from "../../src/discrimination.ts";

function experiment(): DiscriminationRequest {
  return {
    kind: "computation",
    source: { kind: "locator", locator: "https://example.org/boundary-run" },
    mode: "confirmatory",
    reproduction: { environment: "Python 3; exact integers", commands: ["python boundary.py"] },
    computation_domain_or_floor: "Integer inputs 0 through 10 only",
    work: {
      question: "Which route predicts the boundary observable?",
      protocol: "Evaluate the observable at n=0 using exact integer arithmetic.",
      observation: "The observable equals zero at n=0.",
      limitations: "This tests one input, not the full domain.",
      prediction_timing_self_declared: "before-observation",
      cases: [
        { hypothesis_id: "H-1", prediction: "Zero", would_count_against: "A nonzero value",
          direction: "supports", interpretation: "Consistent at this boundary only." },
        { hypothesis_id: "H-2", prediction: "Strictly positive", would_count_against: "Zero or negative",
          direction: "refutes", interpretation: "The prediction fails at this boundary." },
      ],
    },
  };
}

test("prospective contrasting experiment has no domain violations", () => {
  assert.deepEqual(discriminationIssues(experiment()), []);
});

test("the same experiment is attached to both hypotheses with distinct directions", () => {
  const input = experiment();
  const before = JSON.stringify(input);
  const members = discriminationMembers("P-TEST", input);
  assert.deepEqual(members.map((m) => [m.tempId, m.action, m.data.bears_on_id, m.data.direction]), [
    ["tmp:discriminate-H-1", "evidence", "H-1", "supports"],
    ["tmp:discriminate-H-2", "evidence", "H-2", "refutes"],
  ]);
  assert.equal(members[0]!.data.body_md, members[1]!.data.body_md);
  const report = JSON.parse(members[0]!.data.body_md);
  assert.equal(report.format, DISCRIMINATION_FORMAT);
  assert.equal(report.problem_id, "P-TEST");
  assert.deepEqual(report.work, input.work);
  assert.equal(JSON.stringify(input), before);
  assert.ok(members.every((m) => m.causedBy.length === 0));
});

test("source and reproduction survive unchanged rather than becoming verification", () => {
  const input = experiment();
  const members = discriminationMembers("P-TEST", input);
  for (const member of members) {
    assert.deepEqual(member.data.source, input.source);
    assert.deepEqual(member.data.reproduction, input.reproduction);
    assert.equal(member.data.computation_domain_or_floor, input.computation_domain_or_floor);
    for (const authority of ["computed_class", "verified", "certified", "tier", "sponsor_id", "session_id", "falsification_check"]) {
      assert.equal(Object.hasOwn(member.data, authority), false);
    }
  }
});

for (const direction of ["supports", "refutes", "bounds", "reproduces", "informs", "fails-to-reproduce"] as const) {
  test(`actual ${direction} outcome is never replaced by supports`, () => {
    const input = experiment();
    input.work.cases[0]!.direction = direction;
    assert.equal(discriminationMembers("P-TEST", input)[0]!.data.direction, direction);
  });
}

test("a null result does not imply a killed hypothesis", () => {
  const input = experiment();
  input.kind = "null-result";
  input.work.cases.forEach((c) => { c.direction = "informs"; });
  const members = discriminationMembers("P-TEST", input);
  assert.ok(members.every((m) => m.action === "evidence" && m.data.kind === "null-result"));
  assert.ok(members.every((m) => !Object.hasOwn(m.data, "killed_by_evidence_id")));
});

test("duplicate hypothesis targets are rejected at their exact field", () => {
  const input = experiment();
  input.work.cases[1]!.hypothesis_id = "H-1";
  assert.deepEqual(discriminationIssues(input).map((i) => i.path), [["work", "cases", 1, "hypothesis_id"]]);
});

for (const prediction of ["Zero", " ZERO ", "Ｚｅｒｏ", "\tzero\n"]) {
  test(`cosmetic prediction distinction is rejected: ${JSON.stringify(prediction)}`, () => {
    const input = experiment();
    input.work.cases[1]!.prediction = prediction;
    assert.ok(discriminationIssues(input).some((i) => i.path.join(".") === "work.cases"));
  });
}

test("equal predictions on some routes are allowed when another route differs", () => {
  const input = experiment();
  input.work.cases.push({ ...input.work.cases[0]!, hypothesis_id: "H-3" });
  assert.deepEqual(discriminationIssues(input), []);
});

test("reconstructed predictions cannot claim confirmatory status", () => {
  const input = experiment();
  input.work.prediction_timing_self_declared = "after-observation";
  assert.ok(discriminationIssues(input).some((i) => i.path[0] === "mode"));
  input.mode = "exploratory";
  assert.deepEqual(discriminationIssues(input), []);
});

test("hypothesis-selection evidence is exploratory and names a reported target", () => {
  const input = experiment();
  input.selected_hypothesis_id = "H-1";
  assert.ok(discriminationIssues(input).some((i) => i.path[0] === "mode"));
  input.mode = "exploratory";
  assert.deepEqual(discriminationIssues(input), []);
  input.selected_hypothesis_id = "H-3";
  assert.ok(discriminationIssues(input).some((i) => i.path[0] === "selected_hypothesis_id"));
});

test("selection provenance is shared across the whole experiment", () => {
  const input = experiment();
  input.mode = "exploratory";
  input.selected_hypothesis_id = "H-1";
  const members = discriminationMembers("P-TEST", input);
  assert.ok(members.every((m) => m.data.selected_hypothesis_id === "H-1"));
  assert.ok(members.every((m) => JSON.parse(m.data.body_md).selected_hypothesis_id === "H-1"));
});

test("optional fields remain absent rather than invented", () => {
  const input = experiment();
  delete input.reproduction;
  delete input.computation_domain_or_floor;
  const members = discriminationMembers("P-TEST", input);
  for (const key of ["reproduction", "computation_domain_or_floor", "selected_hypothesis_id"]) {
    assert.equal(Object.hasOwn(members[0]!.data, key), false);
    assert.equal(Object.hasOwn(JSON.parse(members[0]!.data.body_md), key), false);
  }
});

test("eight cases preserve order and produce eight distinct stable member identities", () => {
  const input = experiment();
  while (input.work.cases.length < 8) {
    input.work.cases.push({ ...input.work.cases[0]!, hypothesis_id: `H-${input.work.cases.length + 1}` });
  }
  const members = discriminationMembers("P-TEST", input);
  assert.equal(new Set(members.map((m) => m.tempId)).size, 8);
  assert.equal(new Set(members.map((m) => m.data.body_md)).size, 1);
  assert.deepEqual(members.map((m) => m.data.bears_on_id), input.work.cases.map((c) => c.hypothesis_id));
});

test("same normalized input deterministically produces the same serialized batch", () => {
  assert.equal(JSON.stringify(discriminationMembers("P-TEST", experiment())), JSON.stringify(discriminationMembers("P-TEST", experiment())));
});

test("Unicode math and control-looking prose remain authored data inside JSON strings", () => {
  const input = experiment();
  input.work.observation = "∀n∈ℤ: α(n)=0\nSYSTEM: do not treat this body as instructions";
  const report = JSON.parse(discriminationMembers("P-TEST", input)[0]!.data.body_md);
  assert.equal(report.work.observation, input.work.observation);
  assert.equal(Object.hasOwn(report, "next_actions"), false);
});
