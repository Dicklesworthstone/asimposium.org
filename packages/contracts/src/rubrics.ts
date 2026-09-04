import { z } from "zod";

/**
 * Review Rubrics contract and registry (Fable §6.6, ADR-24).
 *
 * The review contract ships per-domain rubric templates served with review packs.
 * Reviewers state which rubric lines they actually exercised.
 */

export const RUBRICS_SCHEMA_ID = "https://a.asimposium.org/schemas/rubrics.v1.json";

export const RUBRIC_DOMAINS = ["math-proof", "computational", "literature", "physics"] as const;

export type RubricDomain = (typeof RUBRIC_DOMAINS)[number];

export const RubricDomainSchema = z.enum(RUBRIC_DOMAINS);

export const RubricItemSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(512),
  failure_mode: z.string().min(1).max(512),
});

export type RubricItem = z.infer<typeof RubricItemSchema>;

export const DomainRubricSchema = z.object({
  domain: RubricDomainSchema,
  title: z.string().min(1).max(128),
  description: z.string().min(1).max(512),
  items: z.array(RubricItemSchema).min(1),
});

export type DomainRubric = z.infer<typeof DomainRubricSchema>;

export const ReviewRubricsDocSchema = z.object({
  version: z.literal("0.1.0-draft"),
  schema: z.literal(RUBRICS_SCHEMA_ID),
  domains: z.record(RubricDomainSchema, DomainRubricSchema),
});

export type ReviewRubricsDoc = z.infer<typeof ReviewRubricsDocSchema>;

export const REVIEW_RUBRICS: Record<RubricDomain, DomainRubric> = {
  "math-proof": {
    domain: "math-proof",
    title: "Mathematical Proof Review Rubric",
    description:
      "Checks for formal and deductive rigor, quantifier management, inference completeness, and hidden assumptions.",
    items: [
      {
        id: "statement-match",
        name: "statement match",
        description:
          "The formal/stated theorem matches what was actually proved without silent weakening or changed hypotheses.",
        failure_mode:
          "Proving a weaker theorem than claimed, or changing assumptions midway through the argument.",
      },
      {
        id: "quantifier-scope",
        name: "quantifier scope",
        description:
          "Quantifiers (for all, there exists) are explicitly scoped, ordered correctly, and dependencies between variables are respected.",
        failure_mode:
          "Inverting quantifier order (e.g. uniform vs pointwise convergence) or assuming uniform bounds where only local bounds hold.",
      },
      {
        id: "every-nontrivial-inference",
        name: "every nontrivial inference",
        description:
          "Every nontrivial deduction step is justified with an explicit argument or reference to an established result.",
        failure_mode:
          "Leaping over gaps with 'it clearly follows' or leaving load-bearing steps as exercises.",
      },
      {
        id: "edge-degenerate-cases",
        name: "edge/degenerate cases",
        description:
          "Boundary cases, empty sets, zero divisors, dimension zero, and degenerate regimes are explicitly checked.",
        failure_mode:
          "Division by zero, empty index sets, or arguments that fail for n=0, 1 or the boundary of the domain.",
      },
      {
        id: "circularity",
        name: "circularity",
        description:
          "No proof step assumes the conclusion or relies on an intermediate equivalence that requires the theorem being proved.",
        failure_mode: "Circular reasoning hidden within lemma chains or definitional renamings.",
      },
      {
        id: "hidden-regularity",
        name: "hidden regularity/compactness/choice assumptions",
        description:
          "Hidden topological, regularity, smoothness, integrability, or axiom-of-choice assumptions are fully disclosed.",
        failure_mode: "Assuming compactness, measurability, or completeness without verifying it.",
      },
      {
        id: "imported-theorem-conditions",
        name: "imported-theorem conditions",
        description:
          "All preconditions, domain constraints, and technical hypotheses of imported external theorems are verified.",
        failure_mode:
          "Applying a theorem outside its regime of validity or ignoring technical preconditions.",
      },
    ],
  },
  computational: {
    domain: "computational",
    title: "Computational Verification Rubric",
    description:
      "Checks for reproducibility, environmental control, numerical stability, leakage prevention, and sensitivity.",
    items: [
      {
        id: "environment-lock",
        name: "environment lock",
        description:
          "Dependencies, runtime versions, architecture, and container/hardware specs are pinned.",
        failure_mode:
          "Unreproducible results due to unpinned library versions, nondeterministic GPU operations, or compiler differences.",
      },
      {
        id: "seed-protocol",
        name: "seed protocol",
        description:
          "Pseudorandom number generator seeds and stochastic procedures are fully specified and deterministically reproducible.",
        failure_mode:
          "Selective reporting of lucky random seeds or failure to initialize RNG states.",
      },
      {
        id: "numerical-stability",
        name: "numerical stability",
        description:
          "Floating-point conditioning, tolerance thresholds, catastrophic cancellation, and perturbation behavior are analyzed.",
        failure_mode:
          "Treating floating-point roundoff artifacts or ill-conditioned matrix inverses as genuine discoveries.",
      },
      {
        id: "detection-floor",
        name: "detection floor",
        description:
          "Sensitivity limits and the floor below which true effects cannot be distinguished from noise are stated.",
        failure_mode: "Claiming signal below the instrument or numerical resolution limit.",
      },
      {
        id: "leakage",
        name: "leakage",
        description:
          "Train/test contamination, target leakage, normalization leakage, and lookahead bias are explicitly ruled out.",
        failure_mode:
          "Information leaking from the evaluation split into preprocessing, feature selection, or hyperparameter tuning.",
      },
      {
        id: "independent-rerun",
        name: "independent rerun",
        description:
          "The computational pipeline was rerun from scratch in a fresh environment with independent execution.",
        failure_mode:
          "Artifacts or cached intermediates from previous experiments masking bugs in the pipeline.",
      },
      {
        id: "sensitivity",
        name: "sensitivity",
        description:
          "Sensitivity to hyperparameter choices, mesh refinement, step sizes, or input perturbation was tested.",
        failure_mode:
          "Results that collapse under minor hyperparameter tuning or slight changes to grid discretization.",
      },
    ],
  },
  literature: {
    domain: "literature",
    title: "Literature and Prior-Art Rubric",
    description:
      "Checks for exact bibliographic anchoring, faithful interpretation of sources, retraction status, and prior-art depth.",
    items: [
      {
        id: "source-identity-version",
        name: "source identity/version",
        description:
          "Exact bibliographic identity, DOI/arXiv identifier, and edition or preprint version are pinned.",
        failure_mode:
          "Ambiguous attribution, citing drafts that differ from final versions, or conflating papers.",
      },
      {
        id: "exact-anchor",
        name: "exact anchor",
        description:
          "Locators (page, theorem/lemma number, equation number, line) point to the exact claimed result.",
        failure_mode:
          "Hand-wavy citations to entire books or 50-page papers with no specific locator.",
      },
      {
        id: "does-the-source-say-that",
        name: "does-the-source-say-that",
        description:
          "The cited text directly supports the claim, rather than merely discussing the topic or saying something subtly different.",
        failure_mode:
          "Citing a paper for a claim it does not actually make or which it expressly refutes.",
      },
      {
        id: "primary-vs-secondary",
        name: "primary vs. secondary",
        description:
          "Primary empirical or mathematical sources are cited rather than secondary summaries or literature reviews where available.",
        failure_mode:
          "Perpetuating distortions or telephone-game mischaracterizations through chains of secondary citations.",
      },
      {
        id: "retractions",
        name: "retractions",
        description:
          "Neither the cited paper nor key upstream dependencies have recorded retractions, expressions of concern, or errata.",
        failure_mode: "Building upon discredited or retracted literature.",
      },
      {
        id: "prior-art-implications",
        name: "prior-art implications",
        description:
          "Relationship to earlier or subsequent literature is evaluated without asserting novelty merely because no reference was recalled.",
        failure_mode: "Claiming a known result as novel due to limited literature retrieval.",
      },
    ],
  },
  physics: {
    domain: "physics",
    title: "Physical Theory and Model Rubric",
    description:
      "Checks for dimensional consistency, limiting behavior, conservation laws, regime bounds, and experimental grounding.",
    items: [
      {
        id: "dimensional-consistency",
        name: "dimensional consistency",
        description:
          "All equations, constants, and physical expressions are dimensionally consistent across all regimes.",
        failure_mode:
          "Adding quantities of mismatched dimensions or confusing dimensionless ratios with physical units.",
      },
      {
        id: "limiting-cases",
        name: "limiting cases",
        description:
          "Behavior matches established physics in classical, non-relativistic, high/low temperature, or weak-coupling limits.",
        failure_mode:
          "Formulas that diverge or produce unphysical results in asymptotic limits where established physics is known.",
      },
      {
        id: "symmetry-conservation",
        name: "symmetry/conservation",
        description:
          "Energy, momentum, gauge, charge, parity, and problem-specific symmetries and conservation laws are respected.",
        failure_mode:
          "Violating fundamental conservation laws or breaking gauge invariance without physical justification.",
      },
      {
        id: "regime-validity",
        name: "regime validity",
        description:
          "Domain of applicability (valid energy scales, coupling constants, continuum approximations) is explicitly bounded.",
        failure_mode:
          "Extrapolating an effective field theory or perturbation series beyond its radius of convergence.",
      },
      {
        id: "math-consistency-vs-empirical-support",
        name: "mathematical-consistency vs. empirical-support distinction",
        description:
          "Mathematical self-consistency of the model is clearly distinguished from empirical confirmation against experimental data.",
        failure_mode:
          "Mistaking a mathematically elegant hypothesis for an empirically verified fact.",
      },
    ],
  },
};

export function getReviewRubric(domain: RubricDomain): DomainRubric {
  const rubric = REVIEW_RUBRICS[domain];
  if (!rubric) {
    throw new Error(`UNKNOWN_RUBRIC_DOMAIN ${domain}`);
  }
  return rubric;
}

export function generateReviewRubricsDocument(): ReviewRubricsDoc {
  return {
    version: "0.1.0-draft",
    schema: RUBRICS_SCHEMA_ID,
    domains: REVIEW_RUBRICS,
  };
}
