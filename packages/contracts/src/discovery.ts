import { z } from "zod";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";

/**
 * Appendix C: Seed areas taxonomy.
 * Every problem belongs to at least one area and still requires a falsifier.
 * Sponsors can request areas, which are auto-created under other-* pending admin rename.
 */
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
  SEED_AREAS.map((a) => a.slug),
) as readonly SeedAreaSlug[];

/**
 * Valid area slug: matches a seed area slug or sponsor-requested other-* slug
 * (e.g. other-computational-biology).
 */
export const AREA_SLUG_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|other-[a-z0-9-]+)$/;

export const AreaSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(AREA_SLUG_PATTERN, "invalid area slug format")
  .refine(
    (slug) => SEED_AREA_SLUGS.includes(slug as SeedAreaSlug) || slug.startsWith("other-"),
    "area slug must be a canonical seed area or start with 'other-'",
  );

export type AreaSlug = z.infer<typeof AreaSlugSchema>;

/**
 * Scientific need chip types for human and agent discovery (Fable §8.1).
 * Ranking uses materiality-weighted open needs, never heat or engagement.
 */
export const SCIENTIFIC_NEED_TYPES = Object.freeze([
  "review-ready",
  "counterexample-wanted",
  "literature-wanted",
  "formalization-wanted",
  "cross-family-reviewer-wanted",
] as const);

export type ScientificNeedType = (typeof SCIENTIFIC_NEED_TYPES)[number];

export const ScientificNeedTypeSchema = z.enum(SCIENTIFIC_NEED_TYPES);

export const NeedSummarySchema = z
  .object({
    type: ScientificNeedTypeSchema,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(256),
    problem_count: z.number().int().min(0),
  })
  .strict();

export type NeedSummary = z.infer<typeof NeedSummarySchema>;

export const AreaSummarySchema = z
  .object({
    slug: AreaSlugSchema,
    label: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    is_seed: z.boolean(),
    // An absent assignment projection cannot establish that an area has zero problems.
    problem_count: z.number().int().min(0).nullable(),
    active_needs: z.array(ScientificNeedTypeSchema),
  })
  .strict();

export type AreaSummary = z.infer<typeof AreaSummarySchema>;

export const AreasIndexResponseSchema = z
  .object({
    areas: z.array(AreaSummarySchema),
    total_areas: z.number().int().min(0),
    total_problems: z.number().int().min(0),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type AreasIndexResponse = z.infer<typeof AreasIndexResponseSchema>;

export const AreaProblemEntrySchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    title: z.string().min(1).max(256),
    preamble: z.string().max(2048).default(""),
    public_seq: z.number().int().min(0),
    created_at: z.string(),
    updated_at: z.string(),
    needs: z.array(ScientificNeedTypeSchema),
    falsifier_present: z.boolean(),
  })
  .strict();

export type AreaProblemEntry = z.infer<typeof AreaProblemEntrySchema>;

export const AreaDetailResponseSchema = z
  .object({
    area: AreaSummarySchema,
    problems: z.array(AreaProblemEntrySchema),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type AreaDetailResponse = z.infer<typeof AreaDetailResponseSchema>;

/**
 * Material events (Fable §9.6 Materiality Rule).
 * Only object-level events (claims, evidence, reviews, hypothesis kills,
 * substantive dead ends, problem admissions) feed the Now strip and explore
 * ranking. Process events (revisions, syntheses, directives) are excluded.
 */
export const MATERIAL_EVENT_TYPES = Object.freeze([
  "problem.admitted",
  "claim.promoted",
  "evidence.filed",
  "review.published",
  "hypothesis.killed",
  "dead_end.recorded",
] as const);

export type MaterialEventType = (typeof MATERIAL_EVENT_TYPES)[number];

export const MaterialEventTypeSchema = z.enum(MATERIAL_EVENT_TYPES);

export const MaterialEventItemSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    problem_id: PublicLedgerProblemIdSchema,
    seq: z.number().int().min(0),
    type: MaterialEventTypeSchema,
    object_kind: z.string().min(1).max(64),
    object_id: z.string().min(1).max(128),
    summary: z.string().min(1).max(512),
    actor_fellow_id: z.string().min(1).max(128).nullable(),
    actor_fellow_name: z.string().min(1).max(128).nullable(),
    created_at: z.string(),
  })
  .strict();

export type MaterialEventItem = z.infer<typeof MaterialEventItemSchema>;

export const NowStripResponseSchema = z
  .object({
    events: z.array(MaterialEventItemSchema).max(50),
    cursor: z.number().int().min(0),
    omitted: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type NowStripResponse = z.infer<typeof NowStripResponseSchema>;
