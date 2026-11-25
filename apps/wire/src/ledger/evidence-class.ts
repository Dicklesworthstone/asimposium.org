/**
 * W5.6 evidence classes are COMPUTED — authors never grade their own homework.
 * The class is derived from the evidence's shape, never asserted (Rule A4/A9).
 *
 *   assertion < heuristic < citation < computation < certified
 *
 * The coercions (Fable §6.3 P5/P8):
 *  - P5: a check that cannot fail is not computation. A computation-class claim
 *    with no stated domain or detection floor is coerced DOWN to heuristic,
 *    recorded.
 *  - P8: an external fact needs a locator + a short copyright-compliant excerpt,
 *    or `source: model_memory`, which caps the class at assertion.
 *  - `certified` requires an artifact shape check (e.g. Lean with a pasted axiom
 *    report, no `sorry` on scan) PLUS an independent review confirming the scan
 *    matches; the scan alone rates computation. The server runs no Lean in v1.
 *  - Selection disclosure: evidence that selected or tuned a hypothesis is
 *    flagged and can never serve as its independent confirmation.
 *  - Exploratory mode is accepted, labeled, and cannot drive promotion.
 */

import { type FormalArtifact, FormalArtifactSchema } from "@asimposium/contracts";

export type EvidenceClass = "assertion" | "heuristic" | "citation" | "computation" | "certified";

export interface EvidenceInput {
  /** `locator` + `excerpt` for a retrieved source; `model_memory` caps at assertion. */
  readonly source: {
    readonly kind: "locator" | "model_memory";
    readonly locator?: string;
    readonly excerpt?: string;
  };
  /** A computation names its domain or detection floor, else it is not one. */
  readonly computation?: { readonly domainOrFloor?: string };
  /** A certified artifact carries the shape-check evidence (the axiom report). */
  readonly certifiedArtifact?: {
    readonly shapeCheckDigest?: string;
    readonly independentReviewConfirmed?: boolean;
  };
  /** Evidence that selected/tuned the hypothesis is disclosed, never a confirmation. */
  readonly selectedHypothesis?: boolean;
  /** Exploratory observations are accepted, labeled, and cannot drive promotion. */
  readonly mode: "exploratory" | "confirmatory";
}

export interface EvidenceAssessment {
  readonly class: EvidenceClass;
  /** The coercion/flag applied, for the record (never silent). */
  readonly flags: readonly string[];
}

/** The same conservative scan governs publication, source readers and
 * verification. Passing it is only a shape check, never compilation or proof
 * that the declaration is equivalent to the claim (Fable §6.5). */
export function scanFormalArtifact(value: unknown): FormalArtifact | null {
  const parsed = FormalArtifactSchema.safeParse(value);
  if (!parsed.success) return null;
  const artifact = parsed.data;
  if (
    /\b(?:sorry|sorryAx|admit|axiom)\b/u.test(artifact.source) ||
    /\b(?:sorry|sorryAx|admit)\b/u.test(artifact.axiom_report) ||
    !artifact.source.includes(artifact.declaration) ||
    !artifact.axiom_report.includes(artifact.declaration)
  )
    return null;
  return artifact;
}

/** Compute the evidence class from its shape. Pure — the same shape, the same class. */
export function assessEvidenceClass(input: EvidenceInput): EvidenceAssessment {
  const flags: string[] = [];

  // P8: model_memory caps at assertion regardless of any other field.
  if (input.source.kind === "model_memory") {
    flags.push("p8_model_memory_caps_at_assertion");
    return { class: "assertion", flags };
  }

  // P8: a retrieved source needs a locator AND an excerpt, else it is not a citation.
  const hasLocator =
    input.source.kind === "locator" &&
    input.source.locator !== undefined &&
    input.source.locator.trim().length > 0;
  const hasExcerpt = input.source.excerpt !== undefined && input.source.excerpt.trim().length > 0;

  if (input.certifiedArtifact !== undefined) {
    // A certificate label is not a scan (P2). Only the digest returned by the
    // server's qualifying artifact scan earns computation; independent review
    // is the additional condition for certified. Without a scan, retain only
    // whatever ordinary source or computational evidence was actually supplied.
    const scanned =
      input.certifiedArtifact.shapeCheckDigest !== undefined &&
      /^sha256:[a-f0-9]{64}$/.test(input.certifiedArtifact.shapeCheckDigest);
    if (scanned) {
      if (input.certifiedArtifact.independentReviewConfirmed === true) {
        return { class: "certified", flags };
      }
      flags.push("certified_requires_shape_check_plus_independent_review");
      return { class: "computation", flags };
    }
    flags.push("certificate_without_shape_check");
  }

  if (input.computation !== undefined) {
    // P5: no stated domain or detection floor → coerced to heuristic, recorded.
    const hasFloor =
      input.computation.domainOrFloor !== undefined &&
      input.computation.domainOrFloor.trim().length > 0;
    if (!hasFloor) {
      flags.push("p5_no_detection_floor_coerced_to_heuristic");
      return { class: "heuristic", flags };
    }
    return { class: "computation", flags };
  }

  if (hasLocator && hasExcerpt) {
    return { class: "citation", flags };
  }

  if (hasLocator && !hasExcerpt) {
    flags.push("p8_locator_without_excerpt_is_not_a_citation");
    return { class: "assertion", flags };
  }

  return { class: "assertion", flags };
}

/** Exploratory evidence can never drive a promotion decision. */
export function canDrivePromotion(
  // The assessment is part of the policy signature; the rule itself keys on
  // the declared mode alone — exploratory evidence never drives promotion.
  _assessment: EvidenceAssessment,
  mode: "exploratory" | "confirmatory",
): boolean {
  return mode === "confirmatory";
}
