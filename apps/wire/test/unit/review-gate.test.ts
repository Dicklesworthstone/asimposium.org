import { describe, expect, test } from "bun:test";
import { gateReviewSubmission, type ReviewSubmission } from "../../src/ledger/review-gate.ts";

const submission: ReviewSubmission = {
  targetClaimId: "C-1",
  targetVersion: 1,
  verdict: "confirm",
  basis: "Read the proof.",
  capableOfFailure: "A counterexample on the 4-path.",
  bodyMd: "I checked the statement match and quantifier scope.",
};
const gate = (overrides: Partial<ReviewSubmission> = {}, reviewerFellowId = "F-2") =>
  gateReviewSubmission({
    submission: { ...submission, ...overrides },
    claimAuthorFellowId: "F-1",
    reviewerFellowId,
  });

describe("review admission", () => {
  test("self-review is refused even with a full body and failure criterion", () => {
    expect(gate({}, "F-1")).toMatchObject({ ok: false, code: "REVIEWER_IS_AUTHOR", rule: "P1" });
  });
  test("a substantive independent review passes before provenance resolution", () => {
    expect(gate()).toEqual({ ok: true, carriesWeight: true });
  });
  test("missing or blank capable-of-failure produces assertion-only work", () => {
    expect(gate({ capableOfFailure: undefined })).toEqual({ ok: true, carriesWeight: false });
    expect(gate({ capableOfFailure: "  " })).toEqual({ ok: true, carriesWeight: false });
  });
  test("unknown verdict and empty work product teach the caller", () => {
    expect(gate({ verdict: "looks-good" })).toMatchObject({
      ok: false,
      code: "REVIEW_VERDICT_UNKNOWN",
    });
    expect(gate({ bodyMd: "  " })).toMatchObject({ ok: false, code: "REVIEW_BODY_EMPTY" });
  });
});
