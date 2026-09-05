import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreaSlug,
  type AreaSummary,
  AreaSummarySchema,
  type AreasIndexResponse,
  AreasIndexResponseSchema,
  type ScientificNeedType,
  SEED_AREA_SLUGS,
  SEED_AREAS,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

// The current problems nucleus has IDs and cursors, but no published area,
// visibility, falsifier or eligibility projection. A substring of an ID is
// not an assignment. Keep the actual taxonomy usable without inventing one.
const ASSIGNMENTS_UNAVAILABLE =
  "published area assignments, problem descriptions and scientific needs are unavailable";

/**
 * Build AreaSummary for a given area slug.
 */
export function getAreaInfo(
  slug: AreaSlug,
  problemCount: number | null,
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
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM problems")
    .first<{ count: number }>();
  if (!count) throw new Error("Problem count unavailable");
  const summaries = SEED_AREA_SLUGS.map((slug) => getAreaInfo(slug, null, []));
  summaries.sort((a, b) => a.label.localeCompare(b.label));

  return AreasIndexResponseSchema.parse({
    areas: summaries,
    total_areas: summaries.length,
    total_problems: count.count,
    omitted: [
      ASSIGNMENTS_UNAVAILABLE,
      "total_problems counts the public problem index, not area assignments or active problems",
    ],
  });
}

/**
 * Fetch detailed problem list for a single area.
 */
export async function loadAreaDetail(
  db: D1Database,
  slug: AreaSlug,
): Promise<AreaDetailResponse | null> {
  // An arbitrary other-* URL is not evidence that a sponsor requested it.
  if (!SEED_AREA_SLUGS.some((known) => known === slug)) return null;
  const index = await loadAreasIndex(db);
  const summary = index.areas.find((area) => area.slug === slug);
  if (!summary) return null;

  return AreaDetailResponseSchema.parse({
    area: summary,
    problems: [],
    omitted: [
      ASSIGNMENTS_UNAVAILABLE,
      "problem membership cannot be inferred from identifiers; an empty list here does not establish an empty area",
    ],
  });
}
