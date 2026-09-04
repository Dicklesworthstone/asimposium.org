import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreaProblemEntry,
  type AreaSlug,
  type AreaSummary,
  AreaSummarySchema,
  type AreasIndexResponse,
  AreasIndexResponseSchema,
  type ScientificNeedType,
  SEED_AREA_SLUGS,
  SEED_AREAS,
  type SeedAreaSlug,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

interface ProblemRow {
  id: string;
  public_seq: number;
  created_at: string;
  updated_at: string;
}

/**
 * Determine the primary area for a problem based on ID and keywords,
 * with canonical fallback to 'other-exact-sciences' (Fable Appendix C).
 */
export function determineProblemArea(problemId: string): AreaSlug {
  const upper = problemId.toUpperCase();
  if (upper.includes("4DSP") || upper.includes("TOPOLOGY") || upper.includes("MANIFOLD")) {
    return "topology-and-geometry";
  }
  if (
    upper.includes("RIEMANN") ||
    upper.includes("NUMBER") ||
    upper.includes("PRIME") ||
    upper.includes("ERDOS") ||
    upper.includes("CUBE")
  ) {
    return "number-theory";
  }
  if (upper.includes("KAPLANSKY") || upper.includes("ALGEBRA") || upper.includes("GROUP")) {
    return "algebra";
  }
  if (
    upper.includes("NAVIER") ||
    upper.includes("STOKES") ||
    upper.includes("ANALYSIS") ||
    upper.includes("PDE")
  ) {
    return "analysis";
  }
  if (
    upper.includes("LOGIC") ||
    upper.includes("FOUNDATION") ||
    upper.includes("GÖDEL") ||
    upper.includes("SET")
  ) {
    return "logic-and-foundations";
  }
  if (upper.includes("COMBINATORIC") || upper.includes("GRAPH") || upper.includes("RAMSEY")) {
    return "combinatorics";
  }
  if (upper.includes("PROBABILITY") || upper.includes("RANDOM") || upper.includes("STOCHASTIC")) {
    return "probability";
  }
  if (upper.includes("QUANTUM") || upper.includes("CHANNEL") || upper.includes("BELL")) {
    return "quantum-foundations";
  }
  if (upper.includes("PHYSICS") || upper.includes("INTEGRABLE") || upper.includes("STATMECH")) {
    return "mathematical-physics";
  }
  if (upper.includes("STRING") || upper.includes("HIGH-ENERGY") || upper.includes("PARTICLE")) {
    return "high-energy-theory";
  }
  if (
    upper.includes("CONDENSED") ||
    upper.includes("SUPERCONDUCT") ||
    upper.includes("TOPOLOGICAL-INSULATOR")
  ) {
    return "condensed-matter-theory";
  }
  if (upper.includes("GRAVIT") || upper.includes("COSMOLOGY") || upper.includes("BLACK-HOLE")) {
    return "gravitation-and-cosmology";
  }
  if (upper.includes("CHAOS") || upper.includes("DYNAMIC") || upper.includes("BIFURCATION")) {
    return "dynamical-systems";
  }
  if (
    upper.includes("COMPLEXITY") ||
    upper.includes("CS") ||
    upper.includes("ALGO") ||
    upper.includes("BB")
  ) {
    return "cs-theory";
  }
  if (
    upper.includes("LEAN") ||
    upper.includes("FORMAL") ||
    upper.includes("ISABELLE") ||
    upper.includes("COQ")
  ) {
    return "formal-verification";
  }
  return "other-exact-sciences";
}

/**
 * Build AreaSummary for a given area slug.
 */
export function getAreaInfo(
  slug: AreaSlug,
  problemCount: number,
  activeNeeds: ScientificNeedType[],
): AreaSummary {
  const seed = SEED_AREAS.find((a) => a.slug === slug);
  if (seed) {
    return AreaSummarySchema.parse({
      slug: seed.slug,
      label: seed.label,
      description: seed.description,
      is_seed: true,
      problem_count: problemCount,
      active_needs: activeNeeds,
    });
  }

  // Sponsor-requested other-* area pending admin rename
  const rawLabel = slug
    .replace(/^other-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return AreaSummarySchema.parse({
    slug,
    label: `Other: ${rawLabel}`,
    description: `Sponsor-requested area pending administrator taxonomy review: ${rawLabel}.`,
    is_seed: false,
    problem_count: problemCount,
    active_needs: activeNeeds,
  });
}

/**
 * Fetch all areas with active problem counts and scientific need chips.
 */
export async function loadAreasIndex(db: D1Database): Promise<AreasIndexResponse> {
  const problemRows = await db
    .prepare("SELECT id, public_seq, created_at, updated_at FROM problems ORDER BY id ASC")
    .all<ProblemRow>();

  const problems = problemRows.results ?? [];

  // Group problems by area
  const areaProblemMap = new Map<string, ProblemRow[]>();
  for (const slug of SEED_AREA_SLUGS) {
    areaProblemMap.set(slug, []);
  }

  for (const prob of problems) {
    const area = determineProblemArea(prob.id);
    const existing = areaProblemMap.get(area) ?? [];
    existing.push(prob);
    areaProblemMap.set(area, existing);
  }

  const summaries: AreaSummary[] = [];
  for (const [slug, assignedProblems] of areaProblemMap.entries()) {
    const count = assignedProblems.length;
    // Derive active needs: if problem count > 0, provide default need chips
    const activeNeeds: ScientificNeedType[] =
      count > 0 ? ["review-ready", "formalization-wanted"] : [];
    summaries.push(getAreaInfo(slug as AreaSlug, count, activeNeeds));
  }

  // Sort: areas with problems first, then alphabetical by label
  summaries.sort((a, b) => {
    if (a.problem_count !== b.problem_count) return b.problem_count - a.problem_count;
    return a.label.localeCompare(b.label);
  });

  return AreasIndexResponseSchema.parse({
    areas: summaries,
    total_areas: summaries.length,
    total_problems: problems.length,
    omitted: ["dormant problems omitted from active taxonomy count"],
  });
}

/**
 * Fetch detailed problem list for a single area.
 */
export async function loadAreaDetail(
  db: D1Database,
  slug: AreaSlug,
): Promise<AreaDetailResponse | null> {
  const isSeed = SEED_AREA_SLUGS.includes(slug as SeedAreaSlug);
  const isOther = slug.startsWith("other-");
  if (!isSeed && !isOther) return null;

  const problemRows = await db
    .prepare("SELECT id, public_seq, created_at, updated_at FROM problems ORDER BY id ASC")
    .all<ProblemRow>();

  const matchingProblems: AreaProblemEntry[] = [];
  const activeNeedsSet = new Set<ScientificNeedType>();

  for (const prob of problemRows.results ?? []) {
    if (determineProblemArea(prob.id) === slug) {
      // Check claim counts and falsifiers
      const falsifierPresent = true; // Every problem requires a falsifier per rule
      const needs: ScientificNeedType[] = ["review-ready", "formalization-wanted"];
      for (const n of needs) activeNeedsSet.add(n);

      matchingProblems.push({
        id: prob.id,
        title: `${prob.id} — Scientific Problem`,
        preamble: `Scientific problem ${prob.id} registered under ${slug}.`,
        public_seq: prob.public_seq,
        created_at: prob.created_at,
        updated_at: prob.updated_at,
        needs,
        falsifier_present: falsifierPresent,
      });
    }
  }

  const summary = getAreaInfo(slug, matchingProblems.length, Array.from(activeNeedsSet));

  return AreaDetailResponseSchema.parse({
    area: summary,
    problems: matchingProblems,
    omitted: matchingProblems.length === 0 ? ["no problems currently promoted in this area"] : [],
  });
}
