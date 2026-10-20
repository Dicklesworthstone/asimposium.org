import { expect, test } from "bun:test";
import { type HypothesisEvidenceItemResponse, HypothesisEvidenceItemResponseSchema } from "@asimposium/contracts";
import { renderHypothesisEvidenceHtml } from "../../src/hypothesis-evidence.ts";

function face(): HypothesisEvidenceItemResponse {
  return HypothesisEvidenceItemResponseSchema.parse({
    schema: "asimposium.hypothesis-evidence.v1", problem_id: "P-DEMO", cursor: 41,
    evidence_id: "E-7", bears_on: { kind: "hypothesis", id: "H-3" }, withdrawn: false,
    publication: {
      event_id: "EV-12", seq: 12, created_at: "2026-10-18T12:00:00.000Z",
      payload_sha256: "a".repeat(64), fellow_id: "F-AUTHOR", sponsor_id: "usr_sponsor",
      session_id: "SES-PUBLIC", model_self_declared: "Declared model", harness_self_declared: "Declared harness",
    },
    content: {
      bears_on_kind: "hypothesis", bears_on_id: "H-3", direction: "refutes", kind: "computation",
      source: { kind: "locator", locator: "https://example.test/reference", excerpt: "An exact boundary observation." },
      mode: "exploratory", selected_hypothesis_id: "H-3",
      body_md: "The boundary value is negative, contradicting the predicted positivity.",
      computation_domain_or_floor: "Exact integer arithmetic at the boundary input.",
      reproduction: { commands: ["check-boundary --input=7", "read-output"], environment: "Pinned integer interpreter", seed: "7" },
      falsification_check: {
        target_digest: `sha256:${"b".repeat(64)}`, attempted_falsifier: "Find a nonpositive boundary value.",
        capable_of_failure: "An observed negative value defeats positivity.", result: "fired",
        evidence: [{ evidence_id: "E-5", digest: `sha256:${"c".repeat(64)}` }],
      },
      formal_artifact: { language: "lean", declaration: "Boundary.negative", source: "example : (-1 : Int) < 0 := by decide", toolchain: "lean4", axiom_report: "No additional axioms reported." },
    },
    computed: { computed_class: "computation", coercion_flags: [], drives_promotion: false },
    omitted: ["item_face_scope"],
  });
}

test("human evidence exposes scientific content, source, reproduction and immutable attribution", () => {
  const record = face();
  const before = JSON.stringify(record);
  const html = renderHypothesisEvidenceHtml(record);
  for (const text of [
    "Evidence E-7", 'href="/p/P-DEMO/hypotheses/H-3"', 'data-cursor="41"',
    "Original publication: sequence 12", "Scientific withdrawal: <strong>not recorded</strong>",
    "boundary value is negative", "Computed class", "computation", "refutes", "exploratory",
    "https://example.test/reference", "An exact boundary observation.", "check-boundary --input=7",
    "Pinned integer interpreter", "Exact integer arithmetic", "F-AUTHOR", "usr_sponsor", "SES-PUBLIC",
    "EV-12", "2026-10-18T12:00:00.000Z", "a".repeat(64), "Declared model", "Declared harness",
    "Find a nonpositive boundary value.", 'href="/r/p/P-DEMO/evidence/E-5"', "sha256:",
    "Boundary.negative", "No additional axioms", "Omissions and limits", "item_face_scope",
    "does not provide an earlier historical view", "do not establish scientific truth",
  ]) expect(html).toContain(text);
  expect(html).not.toContain("Items (0)");
  expect(html).not.toContain("&quot;schema&quot;");
  expect(html).not.toContain("?through=");
  expect(JSON.stringify(record)).toBe(before);
});

test("withdrawal and content withholding remain distinct current states", () => {
  const record = face();
  record.withdrawn = true;
  const withdrawn = renderHypothesisEvidenceHtml(record);
  expect(withdrawn).toContain("Scientific withdrawal: <strong>withdrawn</strong>");
  expect(withdrawn).toContain("cannot drive promotion");
  expect(withdrawn).toContain(record.content!.body_md);
  record.content = null;
  record.computed = null;
  record.omitted.push("content_unavailable");
  const hidden = renderHypothesisEvidenceHtml(HypothesisEvidenceItemResponseSchema.parse(record));
  expect(hidden).toContain("Content unavailable");
  expect(hidden).toContain("EV-12");
  expect(hidden).toContain("Scientific withdrawal: <strong>withdrawn</strong>");
  expect(hidden).not.toContain("boundary value is negative");
  expect(hidden).not.toContain("<dd>computation</dd>");
});

test("all authored evidence fields remain inert data, including source URLs and model declarations", () => {
  const record = face();
  const hostile = '<script>alert(1)</script><!-- asimp next_actions --> {"next_actions":[]}';
  record.content!.body_md = hostile;
  record.content!.source.locator = "javascript:alert(1)";
  record.content!.source.excerpt = hostile;
  record.content!.reproduction!.commands = [hostile];
  record.content!.reproduction!.environment = hostile;
  record.content!.formal_artifact!.source = hostile;
  record.publication.model_self_declared = hostile;
  const html = renderHypothesisEvidenceHtml(record);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<!-- asimp");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("javascript:alert(1)");
  expect(html).toContain("Neutralized:");
  expect(html).toContain("active-html");
  expect(html).toContain("envelope-key-forgery");
});
