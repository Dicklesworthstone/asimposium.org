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
        certifiedArtifact: { shapeCheckDigest: `sha256:${"a".repeat(64)}` },
      }),
    );
    expect(scanOnly.class).toBe("computation");
    expect(scanOnly.flags).toContain("certified_requires_shape_check_plus_independent_review");
    const confirmed = assessEvidenceClass(
      input({
        source: { kind: "locator", locator: "https://x", excerpt: "e" },
        certifiedArtifact: {
          shapeCheckDigest: `sha256:${"a".repeat(64)}`,
          independentReviewConfirmed: true,
        },
      }),
    );
    expect(confirmed.class).toBe("certified");
  });

  test("an unscanned certificate label cannot manufacture computational evidence", () => {
    for (const shapeCheckDigest of [undefined, "", " ", "sha256:x"]) {
      for (const independentReviewConfirmed of [false, true]) {
        const assessment = assessEvidenceClass(
          input({
            source: { kind: "locator", locator: "https://example.org/certificate" },
            certifiedArtifact: { shapeCheckDigest, independentReviewConfirmed },
          }),
        );
        expect(assessment.class).toBe("assertion");
        expect(assessment.flags).toContain("certificate_without_shape_check");
      }
    }
  });

  test("an unscanned certificate retains a sourced citation's actual strength", () => {
    const assessment = assessEvidenceClass(
      input({
        source: {
          kind: "locator",
          locator: "https://example.org/certificate#theorem-1",
          excerpt: "The finite search terminated with no counterexample in the stated domain.",
        },
        certifiedArtifact: {},
      }),
    );
    expect(assessment.class).toBe("citation");
    expect(assessment.flags).toEqual(["certificate_without_shape_check"]);
  });

  test("whitespace cannot supply a computation's detection floor or a source citation", () => {
    for (const whitespace of ["", " ", "\t\n", "\u00a0\u2003\ufeff"]) {
      const computation = assessEvidenceClass(
        input({
          source: { kind: "locator", locator: "https://example.org/result", excerpt: "result" },
          computation: { domainOrFloor: whitespace },
        }),
      );
      expect(computation.class).toBe("heuristic");
      expect(computation.flags).toContain("p5_no_detection_floor_coerced_to_heuristic");
      for (const source of [
        { kind: "locator" as const, locator: whitespace, excerpt: "result" },
        { kind: "locator" as const, locator: "https://example.org/result", excerpt: whitespace },
      ]) {
        expect(assessEvidenceClass(input({ source })).class).toBe("assertion");
      }
    }
  });

  test("exploratory evidence never drives promotion", () => {
    const a = assessEvidenceClass(input({ mode: "exploratory" }));
    expect(canDrivePromotion(a, "exploratory")).toBe(false);
    expect(canDrivePromotion(a, "confirmatory")).toBe(true);
  });
});
