import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreaProblemEntry,
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
import { hiddenByContentControlSql } from "../krater/public-content";
import { readPublishedProblemFormulations } from "../ledger/problem-formulation-read.ts";
import { offScopeProblemSql } from "./public-scope.ts";

const AREA_LIMIT = 64;
const PROBLEM_LIMIT = 50;
// All counts and memberships use the same visibility predicate. Unlisted
// problems remain accessible by their direct URL, never through discovery.
// A problem an operator or community hide controls is not discoverable (f3v1).
const VISIBLE = `p.unlisted = 0 AND p.status NOT IN ('private-draft', 'dormant')
  AND NOT ${offScopeProblemSql("p.id", "p.public_seq")}
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
const SEEDS_SQL = SEED_AREA_SLUGS.map((slug) => `'${slug}'`).join(", ");
const OMITTED = [
  "private, unlisted, dormant and off-scope problems are excluded from area discovery",
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
  // Capture membership and current version/cursor together; then hydrate only
  // their verified public formulations, including the exact source notice.
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
      .prepare(`SELECT p.id, p.public_seq, p.current_statement_version, p.created_at
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
    public_seq: number;
    current_statement_version: number;
    created_at: string;
  }[];
  const formulations = await readPublishedProblemFormulations(
    db,
    rows.map((row) => ({ problem_id: row.id, through: row.public_seq })),
  );
  const problems: AreaProblemEntry[] = [];
  let truncated = false;
  for (const row of rows) {
    const formulation = formulations.get(row.id);
    if (
      formulation === undefined ||
      formulation.problem.current_statement_version !== row.current_statement_version
    )
      continue;
    const { problem, screening_notice } = formulation;
    truncated ||= problem.statement.length > 2048;
    problems.push({
      id: row.id,
      title: problem.title,
      public_seq: row.public_seq,
      created_at: row.created_at,
      updated_at: problem.updated_at,
      // Zod string budgets count UTF-16 code units. Do not split surrogate pairs.
      preamble: problem.statement.slice(0, 2048).replace(/[\uD800-\uDBFF]$/, ""),
      falsifier_present: problem.falsifier.trim().length > 0,
      ...(screening_notice === undefined ? {} : { screening_notice }),
      needs: [],
    });
  }
  const unavailable = rows.length - problems.length;
  const remaining = count.total - count.missing - rows.length;

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
      ...(unavailable > 0
        ? [
            `${unavailable} problem cards omitted because their current published formulation is unavailable`,
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
