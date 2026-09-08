import type { ScientificProvenance } from "@asimposium/contracts";
import type { ScientificEvidence } from "./scientific-checks";

export type IndependenceTier = "T0" | "T1" | "T2" | "T3";

export interface ReviewAttribution {
  readonly sponsorId: string;
  readonly provenance: ScientificProvenance | null;
}

/** Evaluate immutable publication declarations. Model versions, harness names,
 * rubric keywords and current sponsor bindings cannot manufacture independence.
 * Declarations describe provenance; they do not attest to actual model weights.
 * T3 also needs the reviewer's published method work, or its validated external
 * verification of a formal artifact. Merely citing someone else's work is not
 * evidence that the reviewer performed a disjoint method. */
export function scientificIndependence(
  author: ReviewAttribution,
  reviewer: ReviewAttribution,
  reviewerEvidence: readonly ScientificEvidence[],
  methodReview?: { reviewerFellowId: string; verifiedArtifactEvidenceId?: string },
): IndependenceTier {
  if (author.sponsorId === reviewer.sponsorId) return "T0";
  const authorFamily = author.provenance?.model_family_self_declared;
  const reviewerFamily = reviewer.provenance?.model_family_self_declared;
  if (!authorFamily || !reviewerFamily || authorFamily === reviewerFamily) return "T1";
  const authorMethod = author.provenance?.method;
  const reviewerMethod = reviewer.provenance?.method;
  if (
    !authorMethod ||
    !reviewerMethod ||
    authorMethod.category === reviewerMethod.category ||
    reviewerMethod.evidence.length === 0 ||
    reviewerEvidence.length !== reviewerMethod.evidence.length ||
    !reviewerMethod.evidence.every((reference) =>
      reviewerEvidence.some(
        (evidence) =>
          evidence.evidenceId === reference.evidence_id &&
          reference.digest === `sha256:${evidence.payloadDigest}` &&
          methodReview !== undefined &&
          (reviewerMethod.category === "formal"
            ? evidence.kind === "certificate" &&
              evidence.evidenceId === methodReview.verifiedArtifactEvidenceId
            : evidence.fellowId === methodReview.reviewerFellowId &&
              evidence.sponsorId === reviewer.sponsorId &&
              methodMatchesEvidence(reviewerMethod.category, evidence)),
      ),
    )
  )
    return "T2";
  return "T3";
}

function methodMatchesEvidence(category: string, evidence: ScientificEvidence): boolean {
  switch (category) {
    case "deductive":
      return evidence.kind === "argument" || evidence.kind === "construction";
    case "literature":
      return evidence.kind === "citation";
    case "computation":
    case "empirical": {
      const reproduction = evidence.payload.reproduction as { commands?: unknown } | undefined;
      return (
        evidence.kind === "computation" &&
        Array.isArray(reproduction?.commands) &&
        reproduction.commands.length > 0
      );
    }
    case "counterexample":
      return evidence.direction === "refutes" || evidence.direction === "fails-to-reproduce";
    default:
      return false;
  }
}

export function reviewerIsAuthor(authorFellowId: string, reviewerFellowId: string): boolean {
  return authorFellowId === reviewerFellowId;
}

/** Strong support requires cross-family review. */
export function tierMovesDisclosure(tier: IndependenceTier): boolean {
  return tier === "T2" || tier === "T3";
}
