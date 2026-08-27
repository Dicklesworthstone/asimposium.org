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
});
