import { describe, expect, test } from "bun:test";
import {
  INTEGRITY_CASE_PUBLIC_NOTICE,
  INTEGRITY_CASES_SCHEMA_ID,
  PublicIntegrityNoticesResponseSchema,
} from "@asimposium/contracts/integrity-cases";
import {
  integrityNoticeEventPath,
  renderIntegrityNoticesHtml,
  renderIntegrityNoticesMarkdown,
} from "../../src/integrity-notices.ts";

function fixture() {
  return PublicIntegrityNoticesResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID,
    problem_id: "P-INTEGRITY",
    notices: [
      {
        case_id: `IC-${"0".repeat(26)}`,
        source: {
          problem_id: "P-INTEGRITY",
          target_ref: "C-12@3",
          event_id: "E-SOURCE",
          payload_sha256: "a".repeat(64),
          seq: 41,
        },
        state: "open",
        opened_at: "2026-11-24T12:00:00.000Z",
        updated_at: "2026-11-24T12:00:00.000Z",
        corrections: [],
      },
    ],
    has_more: false,
    next_after: null,
  });
}

function firstNotice(face: ReturnType<typeof fixture>) {
  const notice = face.notices[0];
  if (notice === undefined) throw new Error("Expected the fixture publication notice");
  return notice;
}

describe("neutral integrity notice faces", () => {
  test("both faces identify the same immutable source without publishing an allegation", () => {
    const face = fixture();
    for (const text of [renderIntegrityNoticesMarkdown(face), renderIntegrityNoticesHtml(face)]) {
      expect(text).toContain(INTEGRITY_CASE_PUBLIC_NOTICE);
      expect(text).toContain("C-12@3");
      expect(text).toContain("Review is open");
      expect(text).toContain("a".repeat(64));
      expect(text).not.toContain("fabricated-source");
    }
    expect(integrityNoticeEventPath(firstNotice(face).source)).toBe(
      "/p/P-INTEGRITY/events.md?since=40&limit=1",
    );
    expect(renderIntegrityNoticesHtml(face)).toContain("since=40&amp;limit=1");
  });

  test("a concluded notice links corrections as separate publications without a scientific verdict", () => {
    const face = fixture();
    firstNotice(face).state = "resolved";
    firstNotice(face).corrections.push({
      problem_id: "P-INTEGRITY",
      target_ref: "C-12@4",
      event_id: "E-CORRECTION",
      payload_sha256: "b".repeat(64),
      seq: 52,
    });
    for (const text of [renderIntegrityNoticesMarkdown(face), renderIntegrityNoticesHtml(face)]) {
      expect(text).toContain("Review is concluded");
      expect(text).toContain("C-12@4");
      expect(text).toContain("since=51");
      expect(text).not.toContain("confirmed misconduct");
    }
  });

  test("withheld empty pages retain their continuation", () => {
    const face = fixture();
    face.notices = [];
    face.has_more = true;
    face.next_after = `IC-${"0".repeat(26)}`;
    expect(renderIntegrityNoticesMarkdown(face)).toContain("integrity.md?after=IC-");
    expect(renderIntegrityNoticesHtml(face)).toContain('rel="next"');
    expect(renderIntegrityNoticesHtml(face)).not.toContain("No cases exist");
    expect(renderIntegrityNoticesHtml(face)).not.toContain(INTEGRITY_CASE_PUBLIC_NOTICE);
    expect(renderIntegrityNoticesMarkdown(face)).not.toContain(INTEGRITY_CASE_PUBLIC_NOTICE);
  });

  test("restricted case material cannot enter a public renderer through extra fields", () => {
    const face = fixture();
    const leaked = { ...face, investigator_summary: "PRIVATE INVESTIGATION" };
    expect(() => renderIntegrityNoticesMarkdown(leaked)).toThrow();
    expect(() => renderIntegrityNoticesHtml(leaked)).toThrow();
    const sourceLeak = {
      ...face,
      notices: [{ ...firstNotice(face), response: "PRIVATE SPONSOR RESPONSE" }],
    };
    expect(() => renderIntegrityNoticesMarkdown(sourceLeak)).toThrow();
  });
});
