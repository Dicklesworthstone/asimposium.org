import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreaSlug,
  AreaSlugSchema,
  type AreaSummary,
  AreaSummarySchema,
  type AreasIndexResponse,
  AreasIndexResponseSchema,
  type ScientificNeedType,
  SEED_AREA_SLUGS,
  SEED_AREAS,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

const AREA_LIMIT = 64;
const PROBLEM_LIMIT = 50;
// All counts and memberships use the same visibility predicate. Unlisted
// problems remain accessible by their direct URL, never through discovery.
const VISIBLE = "p.unlisted = 0 AND p.status NOT IN ('private-draft', 'dormant')";
const SEEDS_SQL = SEED_AREA_SLUGS.map((slug) => `'${slug}'`).join(", ");
const OMITTED = [
  "private, unlisted and dormant problems are excluded from area discovery",
  "scientific needs and review eligibility are unavailable; assignments do not establish readiness",
];

interface VisibleCounts {
  total: number;
  unassigned: number;
}

function visibleCounts(db: D1Database) {
  return db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(json_array_length(p.areas) = 0), 0) AS unassigned
    FROM problems p WHERE ${VISIBLE}`);
}

function omissions(counts: VisibleCounts): string[] {
  return [
    ...OMITTED,
    ...(counts.unassigned > 0
      ? [
          `${counts.unassigned} visible problems have no recorded area assignments; area counts cover recorded assignments only`,
        ]
      : []),
  ];
}

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
  // Seed rows sort first so a custom-area cap cannot erase a seed's real count.
  // Window totals retain the exact taxonomy size even when the list is bounded.
  const [countResult, areaResult] = await db.batch([
    visibleCounts(db),
    db.prepare(`SELECT a.value AS slug, COUNT(DISTINCT p.id) AS count,
      SUM(CASE WHEN a.value IN (${SEEDS_SQL}) THEN 0 ELSE 1 END) OVER () AS custom_total
      FROM problems p, json_each(p.areas) a
      WHERE ${VISIBLE}
      GROUP BY a.value
      ORDER BY CASE WHEN a.value IN (${SEEDS_SQL}) THEN 0 ELSE 1 END, a.value
      LIMIT ${SEED_AREA_SLUGS.length + AREA_LIMIT}`),
  ]);
  const counts = countResult?.results[0] as unknown as VisibleCounts | undefined;
  if (!counts) throw new Error("Problem count unavailable");
  const rows = areaResult?.results as unknown as {
    slug: string;
    count: number;
    custom_total: number;
  }[];
  const recorded = rows.map((row) => ({ ...row, slug: AreaSlugSchema.parse(row.slug) }));
  const summaries = SEED_AREA_SLUGS.map((slug) =>
    getAreaInfo(slug, recorded.find((row) => row.slug === slug)?.count ?? 0, []),
  );
  const custom = recorded.filter((row) => !SEED_AREA_SLUGS.some((seed) => seed === row.slug));
  summaries.push(...custom.slice(0, AREA_LIMIT).map((row) => getAreaInfo(row.slug, row.count, [])));
  summaries.sort((a, b) => a.label.localeCompare(b.label));
  const customTotal = recorded[0]?.custom_total ?? 0;

  return AreasIndexResponseSchema.parse({
    areas: summaries,
    total_areas: SEED_AREA_SLUGS.length + customTotal,
    total_problems: counts.total,
    omitted: [
      ...omissions(counts),
      ...(customTotal > AREA_LIMIT
        ? [
            `${customTotal - AREA_LIMIT} custom areas omitted after the first ${AREA_LIMIT} by slug; known area URLs remain readable`,
          ]
        : []),
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
  const membership = `${VISIBLE} AND EXISTS (SELECT 1 FROM json_each(p.areas) a WHERE a.value = ?)`;
  const metadata = "length(trim(p.title)) > 0 AND v.problem_id IS NOT NULL";
  // One D1 read transaction pins metadata, membership, counts and truncation.
  const [visibleResult, countResult, problemResult] = await db.batch([
    visibleCounts(db),
    db
      .prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${metadata} THEN 0 ELSE 1 END), 0) AS missing
      FROM problems p LEFT JOIN problem_statement_versions v
        ON v.problem_id = p.id AND v.version = p.current_statement_version
      WHERE ${membership}`)
      .bind(slug),
    db
      .prepare(`SELECT p.id, p.title, p.public_seq, p.created_at, p.updated_at,
      substr(v.statement, 1, 2048) AS preamble, length(v.statement) AS statement_length,
      v.falsifier
      FROM problems p JOIN problem_statement_versions v
        ON v.problem_id = p.id AND v.version = p.current_statement_version
      WHERE ${membership} AND ${metadata}
      ORDER BY p.id LIMIT ${PROBLEM_LIMIT}`)
      .bind(slug),
  ]);
  const visible = visibleResult?.results[0] as unknown as VisibleCounts | undefined;
  const count = countResult?.results[0] as unknown as
    | { total: number; missing: number }
    | undefined;
  if (!visible || !count) throw new Error("Area count unavailable");
  // A private-only or arbitrary other-* URL must not reveal a taxonomy entry.
  if (count.total === 0 && !SEED_AREA_SLUGS.some((known) => known === slug)) return null;
  const rows = problemResult?.results as unknown as {
    id: string;
    title: string;
    public_seq: number;
    created_at: string;
    updated_at: string;
    preamble: string;
    statement_length: number;
    falsifier: string;
  }[];
  const truncated = rows.some((row) => row.statement_length > 2048 || row.preamble.length > 2048);
  const problems = rows.map(({ statement_length: _length, falsifier, ...row }) => ({
    ...row,
    // Zod string budgets count UTF-16 code units. Do not split surrogate pairs.
    preamble: row.preamble.slice(0, 2048).replace(/[\uD800-\uDBFF]$/, ""),
    falsifier_present: falsifier.trim().length > 0,
    needs: [],
  }));
  const remaining = count.total - count.missing - problems.length;

  return AreaDetailResponseSchema.parse({
    area: getAreaInfo(slug, count.total, []),
    problems,
    omitted: [
      ...omissions(visible),
      ...(count.missing > 0
        ? [
            `${count.missing} assigned problems lack a published title or current statement and cannot be listed`,
          ]
        : []),
      ...(remaining > 0
        ? [
            `${remaining} problems omitted after the first ${PROBLEM_LIMIT} by ID; use /problems.json or known problem URLs for further reads`,
          ]
        : []),
      ...(truncated
        ? [
            "statement excerpts are limited to 2048 characters; read the full formulation at /v1/problems/:id",
          ]
        : []),
    ],
  });
}
