import { describe, expect, test } from "bun:test";

import {
  assessEvidenceClass,
  canDrivePromotion,
  type EvidenceInput,
} from "../../src/ledger/evidence-class.ts";

function input(overrides: Partial<EvidenceInput>): EvidenceInput {
  return { source: { kind: "model_memory" }, mode: "confirmatory", ...overrides };
}

describe("W5.6 evidence classes (computed, never asserted)", () => {
  test("P8: model_memory caps at assertion", () => {
    const a = assessEvidenceClass(input({}));
    expect(a.class).toBe("assertion");
    expect(a.flags).toContain("p8_model_memory_caps_at_assertion");
  });

  test("P8: a locator without an excerpt is not a citation", () => {
    const a = assessEvidenceClass(input({ source: { kind: "locator", locator: "https://x" } }));
    expect(a.class).toBe("assertion");
    expect(a.flags).toContain("p8_locator_without_excerpt_is_not_a_citation");
  });

  test("a locator + excerpt is a citation", () => {
    const a = assessEvidenceClass(
      input({ source: { kind: "locator", locator: "https://x", excerpt: "the result" } }),
    );
    expect(a.class).toBe("citation");
  });

  test("P5: a computation with no detection floor is coerced to heuristic, recorded", () => {
    const a = assessEvidenceClass(
      input({ source: { kind: "locator", locator: "https://x", excerpt: "e" }, computation: {} }),
    );
    expect(a.class).toBe("heuristic");
    expect(a.flags).toContain("p5_no_detection_floor_coerced_to_heuristic");
  });

  test("a computation with a stated domain is computation", () => {
    const a = assessEvidenceClass(
      input({
        source: { kind: "locator", locator: "https://x", excerpt: "e" },
        computation: { domainOrFloor: "all n ≤ 10^6" },
      }),
    );
    expect(a.class).toBe("computation");
  });

  test("certified requires the shape check AND an independent review confirming it", () => {
    const scanOnly = assessEvidenceClass(
      input({
        source: { kind: "locator", locator: "https://x", excerpt: "e" },
        certifiedArtifact: { shapeCheckDigest: "sha256:x" },
      }),
    );
    expect(scanOnly.class).toBe("computation");
    expect(scanOnly.flags).toContain("certified_requires_shape_check_plus_independent_review");
    const confirmed = assessEvidenceClass(
      input({
        source: { kind: "locator", locator: "https://x", excerpt: "e" },
        certifiedArtifact: { shapeCheckDigest: "sha256:x", independentReviewConfirmed: true },
      }),
    );
    expect(confirmed.class).toBe("certified");
  });

  test("exploratory evidence never drives promotion", () => {
    const a = assessEvidenceClass(input({ mode: "exploratory" }));
    expect(canDrivePromotion(a, "exploratory")).toBe(false);
    expect(canDrivePromotion(a, "confirmatory")).toBe(true);
  });
});
