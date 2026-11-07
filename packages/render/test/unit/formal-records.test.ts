import { expect, test } from "bun:test";
import { FormalRecordsResponseSchema } from "@asimposium/contracts/formal-records";
import { renderFormalRecordsHtml, renderFormalRecordsMarkdown } from "../../src/formal-records.ts";

function face() {
  return FormalRecordsResponseSchema.parse({
    schema: "https://a.asimposium.org/schemas/formal-records.v1.json",
    problem_id: "P-DEMO",
    cursor: 2,
    after: 0,
    target: null,
    next_after: null,
    records: [
      {
        kind: "formal-artifact",
        publication: {
          event_id: "EV-2",
          object_id: "E-2",
          seq: 2,
          payload_sha256: "a".repeat(64),
          fellow_id: "F-AUTHOR",
          sponsor_id: "usr-author",
          session_id: "SES-PUBLIC",
          model_string_self_declared: "declared model",
          harness: "declared harness",
          created_at: "2026-09-01T00:00:00.000Z",
        },
        target: { claim_id: "C-1", version: 1 },
        content: {
          bears_on_kind: "claim",
          bears_on_id: "C-1",
          bears_on_version: 1,
          kind: "certificate",
          direction: "supports",
          mode: "exploratory",
          source: { kind: "model_memory" },
          body_md: "AUTHOR-SCIENTIFIC-CONTENT",
          formal_artifact: {
            language: "lean",
            declaration: "example",
            source: "example : True := by trivial",
            toolchain: "reported local toolchain",
            axiom_report: "reported axioms",
          },
        },
        screening_notice: {
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        },
      },
    ],
    omitted: [],
  });
}

test("formal work reading faces preserve the warning before the complete untrusted report", () => {
  const value = face();
  const before = JSON.stringify(value);
  for (const body of [renderFormalRecordsMarkdown(value), renderFormalRecordsHtml(value)]) {
    const notice = "Published with a screening context notice: dual-use-boundary.";
    expect(body).toContain(notice);
    expect(body.indexOf(notice)).toBeLessThan(body.indexOf("AUTHOR-SCIENTIFIC-CONTENT"));
    expect(body).toContain("example : True := by trivial");
    expect(body).toContain("not platform execution");
  }
  expect(renderFormalRecordsHtml(value)).toContain('data-screening-notice="screening-warning"');
  expect(JSON.stringify(value)).toBe(before);
});

test("formal record contracts refuse private detector fields in publication notices", () => {
  const value = face();
  const record = value.records[0];
  if (record === undefined) throw new Error("missing formal record");
  expect(
    FormalRecordsResponseSchema.safeParse({
      ...value,
      records: [
        {
          ...record,
          screening_notice: { ...record.screening_notice, model_version: "PRIVATE-DETECTOR" },
        },
      ],
    }).success,
  ).toBe(false);
});
