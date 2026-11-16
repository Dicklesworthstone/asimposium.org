import { z } from "zod";

/** Shared vocabularies for lifecycle, discovery and search. This leaf module
 * keeps search's filters from creating a ledger/discovery initialization cycle. */
export const PROBLEM_STATUSES = [
  "private-draft",
  "sharpening",
  "active",
  "dormant",
  "under-result-review",
  "resolved",
  "retired",
] as const;
export const ProblemStatusSchema = z.enum(PROBLEM_STATUSES);
export type ProblemStatus = z.infer<typeof ProblemStatusSchema>;

/** Appendix C: seed taxonomy. Sponsors may request additional other-* areas. */
export const SEED_AREAS = Object.freeze([
  {
    slug: "algebra",
    label: "Algebra",
    description: "Groups, rings, fields, modules, representation theory, algebraic geometry.",
  },
  {
    slug: "number-theory",
    label: "Number Theory",
    description:
      "Arithmetic geometry, analytic number theory, Diophantine equations, modular forms.",
  },
  {
    slug: "topology-and-geometry",
    label: "Topology & Geometry",
    description:
      "Differential geometry, algebraic topology, geometric analysis, low-dimensional topology.",
  },
  {
    slug: "analysis",
    label: "Analysis",
    description:
      "Harmonic analysis, PDEs, functional analysis, complex analysis, dynamical systems.",
  },
  {
    slug: "logic-and-foundations",
    label: "Logic & Foundations",
    description: "Set theory, model theory, proof theory, constructive mathematics.",
  },
  {
    slug: "combinatorics",
    label: "Combinatorics",
    description: "Graph theory, extremal combinatorics, probabilistic method, enumeration.",
  },
  {
    slug: "probability",
    label: "Probability",
    description: "Stochastic processes, random matrices, percolation, probabilistic combinatorics.",
  },
  {
    slug: "mathematical-physics",
    label: "Mathematical Physics",
    description:
      "Statistical mechanics, integrable systems, conformal field theory, operator algebras.",
  },
  {
    slug: "quantum-foundations",
    label: "Quantum Foundations",
    description: "Quantum information theory, measurement theory, non-locality, quantum channels.",
  },
  {
    slug: "high-energy-theory",
    label: "High Energy Theory",
    description: "String theory, quantum field theory, particle phenomenology, dualities.",
  },
  {
    slug: "condensed-matter-theory",
    label: "Condensed Matter Theory",
    description: "Topological phases, strongly correlated electrons, superconductivity.",
  },
  {
    slug: "gravitation-and-cosmology",
    label: "Gravitation & Cosmology",
    description:
      "General relativity, black hole thermodynamics, gravitational waves, cosmological models.",
  },
  {
    slug: "dynamical-systems",
    label: "Dynamical Systems",
    description: "Ergodic theory, Hamiltonian dynamics, chaos, bifurcations.",
  },
  {
    slug: "cs-theory",
    label: "CS Theory",
    description: "Complexity theory, algorithms, cryptography, automata, computational learning.",
  },
  {
    slug: "formal-verification",
    label: "Formal Verification",
    description:
      "Interactive theorem proving, Lean, Isabelle, Coq, proof assistants, certified software.",
  },
  {
    slug: "other-exact-sciences",
    label: "Other Exact Sciences",
    description: "Other exact sciences requiring falsifiable hypotheses and rigorous deduction.",
  },
] as const);

export type SeedAreaSlug = (typeof SEED_AREAS)[number]["slug"];
export const SEED_AREA_SLUGS = Object.freeze(
  SEED_AREAS.map((area) => area.slug),
) as readonly SeedAreaSlug[];
export const AREA_SLUG_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|other-[a-z0-9-]+)$/;
export const AreaSlugSchema = z.union([
  z.enum(SEED_AREA_SLUGS),
  z
    .string()
    .max(64)
    .regex(/^other-[a-z0-9]+(?:-[a-z0-9]+)*$/, "use a seed area or a named other-* area"),
]);
export type AreaSlug = z.infer<typeof AreaSlugSchema>;
