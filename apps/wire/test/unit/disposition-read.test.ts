import { describe, expect, test } from "bun:test";

import {
  computeClaimDisposition,
  computeCurrentClaimDisposition,
  type VersionedClaimTimelineEvent,
} from "../../src/ledger/disposition-read.ts";
import type { ClaimEvent } from "../../src/ledger/dispositions.ts";

describe("the claim-disposition fold (W5.4 read side)", () => {
  test("a claim with no events is a draft", () => {
    expect(computeClaimDisposition([])).toBe("draft");
  });

  test("promote moves a draft to open", () => {
    expect(computeClaimDisposition([{ kind: "promote" }])).toBe("open");
  });

  test("a refused transition is skipped (the log is the truth, an illegal move is not a move)", () => {
    // A second promote from open is refused by the machine; the claim stays open.
    const events: ClaimEvent[] = [{ kind: "promote" }, { kind: "promote" }];
    expect(computeClaimDisposition(events)).toBe("open");
  });

  test("a malformed claim exits only via a new version (never by review volume)", () => {
    const events: ClaimEvent[] = [
      { kind: "promote" },
      { kind: "operator-repair", reason: "statement defect", to: "malformed" },
    ];
    expect(computeClaimDisposition(events)).toBe("malformed");
  });

  const review = (
    sequence: number,
    targetVersion: number,
    verdict: string,
    carriesWeight = true,
  ): VersionedClaimTimelineEvent => ({
    kind: "review-created",
    sequence,
    targetVersion,
    carriesWeight,
    verdict,
    review: {
      review_id: `R-${sequence}`,
      reviewer_id: `fellow-${sequence}`,
      tier: "T2",
      cross_family: true,
      full_write_up: false,
    },
  });

  test("the current-head fold preserves chronology and never carries an old pin across revision", () => {
    const folded = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "refuting-evidence",
        sequence: 2,
        targetVersion: 1,
        evidenceId: "E-1",
      },
      { kind: "claim-revised", sequence: 3, version: 2 },
      // This late review still belongs to @1 and cannot move @2.
      review(4, 1, "refute"),
    ]);
    expect(folded.currentVersion).toBe(2);
    expect(folded.disposition).toBe("open");
    expect(folded.context.recorded_refutation_attempts).toBe(0);
  });

  test("a future-pinned review is not banked until that version later exists", () => {
    const folded = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      review(2, 2, "refute"),
      { kind: "claim-revised", sequence: 3, version: 2 },
    ]);
    expect(folded.disposition).toBe("open");
    expect(folded.context.recorded_refutation_attempts).toBe(0);
  });

  test("assertion-only and non-dispositive verdicts never manufacture a disposition move", () => {
    for (const candidate of [
      review(2, 1, "refute", false),
      review(2, 1, "inform"),
      review(2, 1, "bounds"),
      review(2, 1, "cannot-verify"),
    ]) {
      const folded = computeCurrentClaimDisposition([
        { kind: "claim-created", sequence: 1, version: 1 },
        candidate,
      ]);
      expect(folded.disposition, candidate.kind === "review-created" ? candidate.verdict : "").toBe(
        "open",
      );
    }
  });

  test("a weight-carrying refute or failed reproduction disputes only its exact current version", () => {
    for (const verdict of ["refute", "fails-to-reproduce"]) {
      const folded = computeCurrentClaimDisposition([
        { kind: "claim-created", sequence: 1, version: 1 },
        review(2, 1, verdict),
      ]);
      expect(folded.disposition, verdict).toBe("disputed");
      expect(folded.context.recorded_refutation_attempts, verdict).toBe(1);
    }
  });

  test("the adapter sorts a real timeline but refuses duplicate or inexact event positions", () => {
    expect(
      computeCurrentClaimDisposition([
        review(2, 1, "refute"),
        { kind: "claim-created", sequence: 1, version: 1 },
      ]).disposition,
    ).toBe("disputed");
    expect(() =>
      computeCurrentClaimDisposition([
        { kind: "claim-created", sequence: 1, version: 1 },
        review(1, 1, "refute"),
      ]),
    ).toThrow(/strict safe-integer sequence/);
    expect(() =>
      computeCurrentClaimDisposition([
        { kind: "claim-created", sequence: Number.MAX_SAFE_INTEGER + 1, version: 1 },
      ]),
    ).toThrow(/strict safe-integer sequence/);
  });

  test("recorded falsification attempt allows open claim to reach corroborated upon independent review", () => {
    // Negative: without falsification attempt, supporting review leaves claim open (open · unchallenged)
    const unchallenged = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      review(2, 1, "confirm"),
    ]);
    expect(unchallenged.disposition).toBe("open");
    expect(unchallenged.context.recorded_refutation_attempts).toBe(0);

    // Positive: with recorded falsification attempt, supporting review moves to corroborated
    const corroborated = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "check parity condition",
        capableOfFailure: "counterexample on 4-cycle",
        result: "unsuccessful-refutation",
      },
      review(3, 1, "confirm"),
    ]);
    expect(corroborated.disposition).toBe("corroborated");
    expect(corroborated.context.recorded_refutation_attempts).toBe(1);
    expect(corroborated.context.verified_reviews).toHaveLength(1);
  });

  test("falsification check rejects invalid or empty checks and duplicate attempts", () => {
    // Empty attemptedFalsifier is rejected
    const emptyFalsifier = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "   ",
        capableOfFailure: "counterexample",
        result: "survived",
      },
      review(3, 1, "confirm"),
    ]);
    expect(emptyFalsifier.disposition).toBe("open");
    expect(emptyFalsifier.context.recorded_refutation_attempts).toBe(0);

    // Empty capableOfFailure is rejected
    const emptyCapable = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "check",
        capableOfFailure: "",
        result: "survived",
      },
      review(3, 1, "confirm"),
    ]);
    expect(emptyCapable.disposition).toBe("open");
    expect(emptyCapable.context.recorded_refutation_attempts).toBe(0);

    // Fired check is refuting, not a surviving falsification attempt
    const fired = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "check",
        capableOfFailure: "counterexample",
        result: "fired",
      },
      review(3, 1, "confirm"),
    ]);
    expect(fired.disposition).toBe("open");
    expect(fired.context.recorded_refutation_attempts).toBe(0);

    // Duplicate attemptId is deduped
    const deduped = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "check 1",
        capableOfFailure: "counterexample",
        result: "survived",
      },
      {
        kind: "falsification-attempt",
        sequence: 3,
        targetVersion: 1,
        attemptId: "E-1",
        attemptedFalsifier: "check 1 duplicate",
        capableOfFailure: "counterexample",
        result: "survived",
      },
    ]);
    expect(deduped.context.recorded_refutation_attempts).toBe(1);
  });

  test("strongly-supported is reachable via certified artifact confirmed by independent review", () => {
    // Positive: corroborated claim advances to strongly-supported when certified artifact confirmed
    const stronglySupported = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "formal proof checker",
        capableOfFailure: "kernel typecheck error",
        result: "survived",
      },
      {
        kind: "certified-artifact",
        sequence: 3,
        targetVersion: 1,
        evidenceId: "E-CERT",
      },
      // Review 1 moves open -> corroborated
      {
        kind: "review-created",
        sequence: 4,
        targetVersion: 1,
        carriesWeight: true,
        verdict: "confirm",
        review: {
          review_id: "R-1",
          reviewer_id: "fellow-independent-1",
          tier: "T2",
          cross_family: true,
          full_write_up: false,
        },
      },
      // Review 2 confirms artifact compilation and statement equivalence -> strongly-supported
      {
        kind: "review-created",
        sequence: 5,
        targetVersion: 1,
        carriesWeight: true,
        verdict: "confirm",
        review: {
          review_id: "R-2",
          reviewer_id: "fellow-independent-2",
          tier: "T2",
          cross_family: true,
          full_write_up: false,
        },
        artifactCompilation: true,
        statementEquivalence: true,
      },
    ]);
    expect(stronglySupported.disposition).toBe("strongly-supported");
    expect(stronglySupported.context.has_certified_artifact).toBe(true);

    // Negative: review missing statementEquivalence does not certify artifact
    const unconfirmedEquivalence = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "formal proof checker",
        capableOfFailure: "kernel typecheck error",
        result: "survived",
      },
      {
        kind: "certified-artifact",
        sequence: 3,
        targetVersion: 1,
        evidenceId: "E-CERT",
      },
      {
        kind: "review-created",
        sequence: 4,
        targetVersion: 1,
        carriesWeight: true,
        verdict: "confirm",
        review: {
          review_id: "R-1",
          reviewer_id: "fellow-independent",
          tier: "T2",
          cross_family: true,
          full_write_up: false,
        },
        artifactCompilation: true,
        statementEquivalence: false,
      },
    ]);
    expect(unconfirmedEquivalence.disposition).toBe("corroborated");
    expect(unconfirmedEquivalence.context.has_certified_artifact).toBe(false);

    // Negative: non-independent (T0) review cannot confirm certified artifact
    const t0Review = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "checker",
        capableOfFailure: "typecheck error",
        result: "survived",
      },
      {
        kind: "certified-artifact",
        sequence: 3,
        targetVersion: 1,
        evidenceId: "E-CERT",
      },
      {
        kind: "review-created",
        sequence: 4,
        targetVersion: 1,
        carriesWeight: true,
        verdict: "confirm",
        review: {
          review_id: "R-1",
          reviewer_id: "fellow-same-harness",
          tier: "T0",
          cross_family: false,
          full_write_up: false,
        },
        artifactCompilation: true,
        statementEquivalence: true,
      },
    ]);
    expect(t0Review.disposition).toBe("open");
    expect(t0Review.context.has_certified_artifact).toBe(false);
  });

  test("strongly-supported is reachable via two distinct cross-family full-write-up reviews", () => {
    const fullReview = (
      seq: number,
      reviewerId: string,
      fullWriteUp = true,
    ): VersionedClaimTimelineEvent => ({
      kind: "review-created",
      sequence: seq,
      targetVersion: 1,
      carriesWeight: true,
      verdict: "confirm",
      review: {
        review_id: `R-${seq}`,
        reviewer_id: reviewerId,
        tier: "T2",
        cross_family: true,
        full_write_up: fullWriteUp,
      },
    });

    // Positive: 2 distinct cross-family full-write-up reviewers reach strongly-supported
    const stronglySupported = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "falsifier check",
        capableOfFailure: "failure scenario",
        result: "survived",
      },
      fullReview(3, "fellow-A", true),
      fullReview(4, "fellow-B", true),
    ]);
    expect(stronglySupported.disposition).toBe("strongly-supported");

    // Negative: same reviewer twice does not satisfy the 2-reviewer requirement
    const sameReviewer = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "falsifier check",
        capableOfFailure: "failure scenario",
        result: "survived",
      },
      fullReview(3, "fellow-A", true),
      fullReview(4, "fellow-A", true),
    ]);
    expect(sameReviewer.disposition).toBe("corroborated");

    // Negative: one review without full_write_up stays corroborated
    const missingFullWriteUp = computeCurrentClaimDisposition([
      { kind: "claim-created", sequence: 1, version: 1 },
      {
        kind: "falsification-attempt",
        sequence: 2,
        targetVersion: 1,
        attemptId: "E-FALS",
        attemptedFalsifier: "falsifier check",
        capableOfFailure: "failure scenario",
        result: "survived",
      },
      fullReview(3, "fellow-A", true),
      fullReview(4, "fellow-B", false),
    ]);
    expect(missingFullWriteUp.disposition).toBe("corroborated");
  });
});
