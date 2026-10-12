import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DISCRIMINATION_FORMAT,
  DiscriminationRequestSchema,
  discriminationBatchRequest,
  generateDiscriminationSchema,
  readDiscriminationReport,
} from "../../src/discrimination.ts";
import { EventBatchRequestSchema } from "../../src/batch.ts";
import { EvidenceRequestSchema } from "../../src/sessions.ts";

// Fixed should-pass work product. No author, sponsor, session, computed class or
// scientific verdict is synthesized by this convenience request.
function valid() {
  return {
    kind: "computation",
    source: { kind: "locator", locator: "https://example.org/observations/boundary" },
    mode: "confirmatory",
    reproduction: { environment: "Exact integer arithmetic", commands: ["python boundary.py"] },
    computation_domain_or_floor: "n=0; exact arithmetic, no measurement error",
    work: {
      question: "Which of the routes predicts the boundary value?",
      protocol: "Compute the same observable for n=0 against both predictions.",
      observation: "The value was zero at the tested input.",
      limitations: "One boundary case does not establish the full claim.",
      prediction_timing_self_declared: "before-observation",
      cases: [
        { hypothesis_id: "H-1", prediction: "Zero", would_count_against: "A nonzero value", direction: "supports", interpretation: "Consistent at this input only." },
        { hypothesis_id: "H-2", prediction: "Strictly positive", would_count_against: "A zero or negative value", direction: "refutes", interpretation: "The observation contradicts this prediction." },
      ],
    },
  };
}

test("valid discrimination expands only to canonical hypothesis evidence", () => {
  const request = valid();
  const batch = discriminationBatchRequest(request, "P-TEST");
  assert.equal(EventBatchRequestSchema.safeParse(batch).success, true);
  assert.equal(batch.members.length, 2);
  for (const member of batch.members) {
    assert.equal(member.action, "evidence");
    assert.equal(EvidenceRequestSchema.safeParse(member.data).success, true);
    assert.equal(member.data.bears_on_kind, "hypothesis");
    assert.equal(Object.hasOwn(member.data, "bears_on_version"), false);
    const report = readDiscriminationReport(String(member.data.body_md));
    assert.ok(report);
    assert.equal(report.format, DISCRIMINATION_FORMAT);
    assert.equal(report.problem_id, "P-TEST");
    assert.deepEqual(report.work, request.work);
  }
});

for (const field of ["fellow_id", "sponsor_id", "session_id", "computed_class", "verified", "independence_tier"]) {
  test(`rejects caller-provided authority ${field}`, () => {
    assert.equal(DiscriminationRequestSchema.safeParse({ ...valid(), [field]: "claimed" }).success, false);
  });
}
for (const kind of ["certificate", "formalization-friction", "fabricated", "citation"]) {
  test(`does not invent ${kind} verification through experiment publication`, () => {
    assert.equal(DiscriminationRequestSchema.safeParse({ ...valid(), kind }).success, false);
  });
}
for (const field of ["question", "protocol", "observation", "limitations"]) {
  test(`requires substantive ${field}`, () => {
    const request = valid();
    assert.equal(DiscriminationRequestSchema.safeParse({ ...request, work: { ...request.work, [field]: "   " } }).success, false);
  });
}
for (const field of ["prediction", "would_count_against", "direction", "interpretation"]) {
  test(`requires every case's ${field}`, () => {
    const request = valid();
    const first: Record<string, unknown> = { ...request.work.cases[0] };
    delete first[field];
    assert.equal(DiscriminationRequestSchema.safeParse({ ...request, work: { ...request.work, cases: [first, request.work.cases[1]] } }).success, false);
  });
}

test("work, cases, source and reproduction all reject unknown fields", () => {
  const request = valid();
  const invalid = [
    { ...request, work: { ...request.work, chain_of_thought: "not a work product" } },
    { ...request, work: { ...request.work, cases: [{ ...request.work.cases[0], certified: true }, request.work.cases[1]] } },
    { ...request, source: { ...request.source, verified: true } },
    { ...request, reproduction: { ...request.reproduction, executed_by_platform: true } },
  ];
  assert.ok(invalid.every((body) => !DiscriminationRequestSchema.safeParse(body).success));
});

test("rejects duplicate targets and cosmetic-only differences", () => {
  const duplicate = valid();
  duplicate.work.cases[1]!.hypothesis_id = "H-1";
  assert.equal(DiscriminationRequestSchema.safeParse(duplicate).success, false);
  const repeated = valid();
  repeated.work.cases[1]!.prediction = " ＺＥＲＯ ";
  assert.equal(DiscriminationRequestSchema.safeParse(repeated).success, false);
});

test("two through eight hypotheses only", () => {
  const request = valid();
  assert.equal(DiscriminationRequestSchema.safeParse({ ...request, work: { ...request.work, cases: request.work.cases.slice(0, 1) } }).success, false);
  while (request.work.cases.length < 8) request.work.cases.push({ ...request.work.cases[0]!, hypothesis_id: `H-${request.work.cases.length + 1}` });
  assert.equal(DiscriminationRequestSchema.safeParse(request).success, true);
  request.work.cases.push({ ...request.work.cases[0]!, hypothesis_id: "H-9" });
  assert.equal(DiscriminationRequestSchema.safeParse(request).success, false);
});

test("retrospective prediction and selection evidence cannot self-label confirmatory", () => {
  const request = valid();
  request.work.prediction_timing_self_declared = "after-observation";
  assert.equal(DiscriminationRequestSchema.safeParse(request).success, false);
  request.mode = "exploratory";
  assert.equal(DiscriminationRequestSchema.safeParse(request).success, true);
  assert.equal(DiscriminationRequestSchema.safeParse({ ...valid(), selected_hypothesis_id: "H-1" }).success, false);
  assert.equal(DiscriminationRequestSchema.safeParse({ ...request, selected_hypothesis_id: "H-1" }).success, true);
  assert.equal(DiscriminationRequestSchema.safeParse({ ...request, selected_hypothesis_id: "H-9" }).success, false);
});

test("source constraints are inherited, not replaced by a tool-result assertion", () => {
  assert.equal(DiscriminationRequestSchema.safeParse({ ...valid(), source: { kind: "tool_result" } }).success, false);
  assert.equal(DiscriminationRequestSchema.safeParse({ ...valid(), source: { kind: "model_memory" } }).success, true);
});

test("expanded JSON amplification is rejected even within individual field limits", () => {
  const request = valid();
  while (request.work.cases.length < 8) request.work.cases.push({ ...request.work.cases[0]!, hypothesis_id: `H-${request.work.cases.length + 1}` });
  request.work.protocol = "\\".repeat(6000);
  request.work.observation = "\\".repeat(6000);
  request.work.limitations = "\\".repeat(4000);
  assert.equal(DiscriminationRequestSchema.safeParse(request).success, true);
  assert.throws(() => discriminationBatchRequest(request, "P-TEST"), /DISCRIMINATION_BATCH_TOO_LARGE/);
});

test("the encoder uses the existing public problem ID contract", () => {
  assert.throws(() => discriminationBatchRequest(valid(), "../../private"));
});

test("typed report decoder rejects arbitrary prose, malformed JSON and spoofed fields", () => {
  assert.equal(readDiscriminationReport("A discrimination test was successful."), null);
  assert.equal(readDiscriminationReport("{"), null);
  assert.equal(readDiscriminationReport(JSON.stringify(valid())), null);
  const batch = discriminationBatchRequest(valid(), "P-TEST");
  const report = JSON.parse(String(batch.members[0]!.data.body_md));
  assert.equal(readDiscriminationReport(JSON.stringify({ ...report, verified: true })), null);
  assert.equal(readDiscriminationReport("x".repeat(65537)), null);
});

test("public schema is generated from the actual request, report and ordinary receipt", () => {
  const schema = JSON.parse(generateDiscriminationSchema());
  assert.equal(schema.$id, "https://a.asimposium.org/schemas/discrimination.v1.json");
  assert.deepEqual(Object.keys(schema.properties), ["discrimination_request", "discrimination_report", "discrimination_response"]);
  assert.equal(schema.properties.discrimination_request.additionalProperties, false);
  assert.equal(schema.properties.discrimination_request.properties.work.properties.cases.maxItems, 8);
  assert.match(schema.$comment, /one experiment, not independent replication/);
});
