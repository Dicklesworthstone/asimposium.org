import { describe, expect, test } from "bun:test";
import {
  type ClaimDisposition,
  type ClaimEvent,
  type ClaimTransitionContext,
  EMPTY_CLAIM_CONTEXT,
  evaluateClaimTransition,
  type VerifiedReview,
  wearsMachineCheckedBadge,
} from "../../src/ledger/dispositions.ts";

const support = (id: string): VerifiedReview => ({
  review_id: id,
  reviewer_id: `fellow-${id}`,
  tier: "T2",
  cross_family: true,
  full_write_up: true,
  finding: "support",
});
const supported: ClaimTransitionContext = {
  recorded_refutation_attempts: 1,
  verified_reviews: [support("R-1"), support("R-2")],
  has_certified_artifact: true,
};
const defect: ClaimEvent = {
  kind: "review-verified",
  review: { ...support("R-defect"), finding: "statement-defect" },
};
const refutation: ClaimEvent = {
  kind: "evidence-refuted",
  evidence_id: "E-refutation",
  confirmed_by_independent_review: false,
  unanswered_hours: 0,
};

function apply(current: ClaimDisposition, event: ClaimEvent): ClaimDisposition {
  const result = evaluateClaimTransition(current, event, supported);
  return result.allowed ? result.next : current;
}

describe("negative scientific findings outrank apparent progress", () => {
  for (const current of [
    "open",
    "disputed",
    "corroborated",
    "strongly-supported",
    "reduced-to",
  ] as const) {
    test(`a statement defect makes ${current} malformed`, () => {
      expect(evaluateClaimTransition(current, defect, supported)).toEqual({
        allowed: true,
        next: "malformed",
      });
    });
  }

  test("a certified claim loses its badge when a statement defect lands", () => {
    expect(wearsMachineCheckedBadge("strongly-supported", supported)).toBe(true);
    const next = apply("strongly-supported", defect);
    expect(next).toBe("malformed");
    expect(wearsMachineCheckedBadge(next, supported)).toBe(false);
    expect(apply(next, { kind: "review-verified", review: support("R-3") })).toBe("malformed");
    expect(apply(next, { kind: "reduced-to", target_claim_id: "C-2" })).toBe("malformed");
    expect(apply(next, { kind: "new-version", new_version: 2 })).toBe("open");
  });

  test("a reduction cannot immunize a claim against refuting evidence", () => {
    expect(apply("reduced-to", refutation)).toBe("disputed");
    expect(
      apply("reduced-to", {
        ...refutation,
        confirmed_by_independent_review: true,
        unanswered_hours: 72,
      }),
    ).toBe("refuted");
  });

  test("a reduced claim still needs both conditions for settled refutation", () => {
    for (const [confirmed, hours] of [
      [false, 72],
      [true, 71],
      [false, 0],
    ] as const) {
      expect(
        apply("reduced-to", {
          ...refutation,
          confirmed_by_independent_review: confirmed,
          unanswered_hours: hours,
        }),
      ).toBe("disputed");
    }
  });

  test("reduction and refutation order cannot erase a live contest", () => {
    const reduction: ClaimEvent = { kind: "reduced-to", target_claim_id: "C-2" };
    expect(apply(apply("open", reduction), refutation)).toBe("disputed");
    expect(apply(apply("open", refutation), reduction)).toBe("disputed");
    expect(
      apply(apply("open", refutation), {
        kind: "review-verified",
        review: support("R-3"),
      }),
    ).toBe("disputed");
  });

  test("ordinary reduction remains bookkeeping on an uncontested claim", () => {
    expect(apply("open", { kind: "reduced-to", target_claim_id: "C-2" })).toBe("reduced-to");
    expect(
      evaluateClaimTransition("disputed", { kind: "reduced-to", target_claim_id: " " }, supported)
        .allowed,
    ).toBe(false);
  });

  test("negative findings do not reopen drafts or terminal versions", () => {
    for (const current of ["draft", "refuted", "withdrawn", "superseded"] as const) {
      expect(evaluateClaimTransition(current, defect, supported).allowed).toBe(false);
      expect(evaluateClaimTransition(current, refutation, supported).allowed).toBe(false);
    }
  });

  test("honest positive and refuter-first paths are unchanged", () => {
    const event: ClaimEvent = { kind: "review-verified", review: support("R-3") };
    expect(evaluateClaimTransition("open", event, EMPTY_CLAIM_CONTEXT).allowed).toBe(false);
    expect(apply("open", event)).toBe("corroborated");
    expect(apply("corroborated", event)).toBe("strongly-supported");
  });
});
