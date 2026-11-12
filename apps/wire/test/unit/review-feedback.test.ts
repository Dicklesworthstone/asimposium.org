import { describe, expect, test } from "bun:test";
import { REVIEW_FEEDBACK_SAMPLE_LIMIT } from "@asimposium/contracts";
import { summarizeReviewFeedback } from "../../src/sessions/review-feedback.ts";

const row = (seconds: number | null, overrides = {}) => ({
  through_seq: 100,
  publication_seq: 1,
  published_at: "2026-01-01T00:00:00Z",
  visible: 1,
  excluded_review: 0,
  first_review_at:
    seconds === null
      ? null
      : new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000).toISOString(),
  ...overrides,
});

describe("observed review feedback arithmetic", () => {
  test("empty public scope and absent/private scope are different", () => {
    expect(summarizeReviewFeedback([])).toBeNull();
    expect(summarizeReviewFeedback([row(null, { publication_seq: null })])).toEqual({
      basis: "first-readable-non-author-review-on-version",
      through_seq: 100,
      sample_limit: 128,
      sampled_versions: 0,
      reviewed_versions: 0,
      unreviewed_versions: 0,
      unmeasurable_versions: 0,
      median_first_review_seconds: null,
      omitted: [],
    });
  });
  test.each([
    [[9], 9],
    [[9, 1], 5],
    [[100, 1, 2], 2],
    [[10, 1, 20, 4], 7],
    [[0, 0.001], 0.0005],
  ])("median of %j is %s", (seconds, median) => {
    const result = summarizeReviewFeedback(seconds.map((value) => row(value)));
    expect(result?.median_first_review_seconds).toBe(median);
    expect(result?.sampled_versions).toBe(seconds.length);
    expect(result?.reviewed_versions).toBe(seconds.length);
    expect(result?.omitted).toEqual([]);
  });
  test("unreviewed and unmeasurable remain explicit disjoint countermetrics", () => {
    const result = summarizeReviewFeedback([
      row(3),
      row(null),
      row(-1),
      row(4, { first_review_at: "not-a-clock" }),
      row(5, { published_at: "2026-02-30T00:00:00Z" }),
      row(6, { visible: 0 }),
    ]);
    expect(result).toEqual({
      basis: "first-readable-non-author-review-on-version",
      through_seq: 100,
      sample_limit: 128,
      sampled_versions: 5,
      reviewed_versions: 1,
      unreviewed_versions: 1,
      unmeasurable_versions: 3,
      median_first_review_seconds: 3,
      omitted: ["content_unavailable", "invalid_timestamp"],
    });
    expect(summarizeReviewFeedback([row(null), row(-1)])?.median_first_review_seconds).toBeNull();
  });
  test("bound precedes filtering and omissions are canonical without refill", () => {
    const rows = Array.from({ length: REVIEW_FEEDBACK_SAMPLE_LIMIT + 1 }, () =>
      row(2, { visible: 0 }),
    );
    rows[REVIEW_FEEDBACK_SAMPLE_LIMIT] = row(1000);
    const result = summarizeReviewFeedback(rows);
    expect(result?.sampled_versions).toBe(0);
    expect(result?.median_first_review_seconds).toBeNull();
    expect(result?.omitted).toEqual(["sample_limit", "content_unavailable"]);
  });
  test("unavailable reviews disclose an omission without inventing a duration", () => {
    const result = summarizeReviewFeedback([
      row(null, { excluded_review: 1 }),
      row(3, { excluded_review: 1 }),
    ]);
    expect(result?.sampled_versions).toBe(2);
    expect(result?.reviewed_versions).toBe(1);
    expect(result?.unreviewed_versions).toBe(1);
    expect(result?.median_first_review_seconds).toBe(3);
    expect(result?.omitted).toEqual(["content_unavailable"]);
  });
  test("inconsistent cuts cannot mint a summary", () => {
    expect(() => summarizeReviewFeedback([row(1), row(2, { through_seq: 99 })])).toThrow();
  });
});
