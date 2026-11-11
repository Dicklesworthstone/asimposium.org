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
  SCIENTIFIC_NEED_TYPES,
  type ScientificNeedType,
  SEED_AREA_SLUGS,
  SEED_AREAS,
} from "@asimposium/contracts";
import {
  REVIEW_QUEUE_PAGE_SIZE,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content";
import { readPublishedProblemFormulations } from "../ledger/problem-formulation-read.ts";
import { offScopeProblemSql } from "./public-scope.ts";
import { loadReviewQueue } from "./review-queue-service.ts";

const AREA_LIMIT = 64;
const PROBLEM_LIMIT = 50;
// All counts and memberships use the same visibility predicate. Unlisted
// problems remain accessible by their direct URL, never through discovery.
// A problem an operator or community hide controls is not discoverable (f3v1).
export const AREA_PROBLEM_VISIBILITY_SQL = `p.unlisted = 0 AND p.status NOT IN ('private-draft', 'dormant')
  AND NOT ${offScopeProblemSql("p.id", "p.public_seq")}
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
const VISIBLE = AREA_PROBLEM_VISIBILITY_SQL;
const SEEDS_SQL = SEED_AREA_SLUGS.map((slug) => `'${slug}'`).join(", ");
const OMITTED = [
  "private, unlisted, dormant and off-scope problems are excluded from area discovery",
  "Other scientific needs and current Fellow review eligibility are unavailable; review recommendations do not grant permission.",
];
const REVIEW_NEEDS_BOUNDARY = `Need chips sample at most ${REVIEW_QUEUE_PAGE_SIZE} candidates from the public review queue's first page. Empty chips do not establish no needs; read /reviews.json for more.`;

interface ReviewMembership {
  id: string;
  cursor: number;
  areas: string;
}

interface AreaReviewNeeds {
  problems: Map<string, { cursor: number; needs: ScientificNeedType[] }>;
  areas: Map<AreaSlug, ScientificNeedType[]>;
  omitted: string[];
}

async function areaReviewQueue(db: D1Database): Promise<ReviewQueueResponse | undefined> {
  try {
    return await loadReviewQueue(db);
  } catch {
    // Review enrichment must not take the existing formulation/count reads down.
    return undefined;
  }
}

function reviewMemberships(db: D1Database, queue: ReviewQueueResponse | undefined) {
  const pins = queue?.candidates.map(({ problem_id, cursor }) => ({ problem_id, cursor })) ?? [];
  // Run in the same batch as counts and cards. A changed, hidden, unlisted,
  // dormant or off-scope problem cannot attach an old review need to an area.
  return db
    .prepare(`SELECT DISTINCT p.id, p.public_seq AS cursor, p.areas
      FROM problems p JOIN json_each(?) pin
        ON p.id = json_extract(pin.value, '$.problem_id')
        AND p.public_seq = json_extract(pin.value, '$.cursor')
      WHERE ${VISIBLE}`)
    .bind(JSON.stringify(pins));
}

function areaReviewNeeds(
  queue: ReviewQueueResponse | undefined,
  rows: readonly ReviewMembership[] | undefined,
): AreaReviewNeeds {
  const result: AreaReviewNeeds = {
    problems: new Map(),
    areas: new Map(),
    omitted: [REVIEW_NEEDS_BOUNDARY],
  };
  if (!queue || !Array.isArray(rows)) {
    result.omitted.push(
      "Public review-need discovery is unavailable; area assignments and counts remain readable.",
    );
    return result;
  }
  const problemNeeds = new Map<string, Set<ScientificNeedType>>();
  const areaNeeds = new Map<AreaSlug, Set<ScientificNeedType>>();
  let changed = false;
  for (const candidate of queue.candidates) {
    const membership = rows.find(
      (row) => row.id === candidate.problem_id && row.cursor === candidate.cursor,
    );
    if (!membership) {
      changed = true;
      continue;
    }
    const slugs: unknown = JSON.parse(membership.areas);
    if (!Array.isArray(slugs) || slugs.some((slug) => !AreaSlugSchema.safeParse(slug).success))
      throw new Error("AREA_REVIEW_MEMBERSHIP_INVALID");
    const needs = problemNeeds.get(candidate.problem_id) ?? new Set<ScientificNeedType>();
    needs.add("review-ready");
    if (candidate.need === "cross-family-review") needs.add("cross-family-reviewer-wanted");
    if (candidate.need === "falsification-attempt") needs.add("counterexample-wanted");
    problemNeeds.set(candidate.problem_id, needs);
    result.problems.set(candidate.problem_id, {
      cursor: candidate.cursor,
      needs: SCIENTIFIC_NEED_TYPES.filter((need) => needs.has(need)),
    });
    for (const slug of slugs as AreaSlug[]) {
      const current = areaNeeds.get(slug) ?? new Set<ScientificNeedType>();
      for (const need of needs) current.add(need);
      areaNeeds.set(slug, current);
    }
  }
  for (const [slug, needs] of areaNeeds)
    result.areas.set(
      slug,
      SCIENTIFIC_NEED_TYPES.filter((need) => needs.has(need)),
    );
  if (changed)
    result.omitted.push(
      "Some sampled review needs changed or are no longer discoverable; their chips were omitted.",
    );
  if (queue.next_after || queue.omitted.length > 0)
    result.omitted.push(
      "The sampled review queue omits additional or unavailable work; follow /reviews.json for its continuation and details.",
    );
  return result;
}

interface VisibleCounts {
  total: number;
  unassigned: number;
}

function visibleCounts(db: D1Database) {
  return db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(json_array_length(p.areas) = 0), 0) AS unassigned
    FROM problems p WHERE ${VISIBLE}`);
}

function omissions(counts: VisibleCounts, needs: AreaReviewNeeds): string[] {
  return [
    ...OMITTED,
    ...needs.omitted,
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
  rename?: { new_title: string; event_id: string; created_at: string },
): AreaSummary {
  const change =
    rename === undefined
      ? {}
      : {
          label_change: { event_id: rename.event_id, renamed_at: rename.created_at },
        };
  const seed = SEED_AREAS.find((a) => a.slug === slug);
  if (seed) {
    return AreaSummarySchema.parse({
      slug: seed.slug,
      label: rename?.new_title ?? seed.label,
      description: seed.description,
      is_seed: true,
      problem_count: problemCount,
      active_needs: activeNeeds,
      ...change,
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
    label: rename?.new_title ?? `Other: ${rawLabel}`,
    description:
      rename === undefined
        ? `Sponsor-requested area pending administrator taxonomy review: ${rawLabel}.`
        : `Sponsor-requested scientific area: ${rawLabel}.`,
    is_seed: false,
    problem_count: problemCount,
    active_needs: activeNeeds,
    ...change,
  });
}

/**
 * Fetch all areas with active problem counts and scientific need chips.
 */
export async function loadAreasIndex(db: D1Database): Promise<AreasIndexResponse> {
  const queue = await areaReviewQueue(db);
  // Seed rows sort first so a custom-area cap cannot erase a seed's real count.
  // Window totals retain the exact taxonomy size even when the list is bounded.
  const [countResult, areaResult, reviewResult] = await db.batch([
    visibleCounts(db),
    db.prepare(`SELECT a.value AS slug, COUNT(DISTINCT p.id) AS count,
      SUM(CASE WHEN a.value IN (${SEEDS_SQL}) THEN 0 ELSE 1 END) OVER () AS custom_total
      FROM problems p, json_each(p.areas) a
      WHERE ${VISIBLE}
      GROUP BY a.value
      ORDER BY CASE WHEN a.value IN (${SEEDS_SQL}) THEN 0 ELSE 1 END, a.value
      LIMIT ${SEED_AREA_SLUGS.length + AREA_LIMIT}`),
    reviewMemberships(db, queue),
  ]);
  // Read only the bounded, already-public taxonomy, never every private slug.
  const slugs = [
    ...SEED_AREA_SLUGS,
    ...((areaResult?.results ?? []) as { slug: string }[]).map((row) => row.slug),
  ];
  const renames = await db
    .prepare(`SELECT area_slug, new_title, event_id, created_at
    FROM area_rename_events e WHERE area_slug IN (SELECT value FROM json_each(?))
    AND seq = (SELECT MAX(seq) FROM area_rename_events latest WHERE latest.area_slug = e.area_slug)`)
    .bind(JSON.stringify(slugs))
    .all<{ area_slug: string; new_title: string; event_id: string; created_at: string }>();
  const latest = new Map(renames.results.map((row) => [row.area_slug, row]));
  const needs = areaReviewNeeds(queue, reviewResult?.results as unknown as ReviewMembership[]);
  const counts = countResult?.results[0] as unknown as VisibleCounts | undefined;
  if (!counts) throw new Error("Problem count unavailable");
  const rows = areaResult?.results as unknown as {
    slug: string;
    count: number;
    custom_total: number;
  }[];
  const recorded = rows.map((row) => ({ ...row, slug: AreaSlugSchema.parse(row.slug) }));
  const summaries = SEED_AREA_SLUGS.map((slug) =>
    getAreaInfo(
      slug,
      recorded.find((row) => row.slug === slug)?.count ?? 0,
      needs.areas.get(slug) ?? [],
      latest.get(slug),
    ),
  );
  const custom = recorded.filter((row) => !SEED_AREA_SLUGS.some((seed) => seed === row.slug));
  summaries.push(
    ...custom
      .slice(0, AREA_LIMIT)
      .map((row) =>
        getAreaInfo(row.slug, row.count, needs.areas.get(row.slug) ?? [], latest.get(row.slug)),
      ),
  );
  summaries.sort((a, b) => a.label.localeCompare(b.label));
  const customTotal = recorded[0]?.custom_total ?? 0;

  return AreasIndexResponseSchema.parse({
    areas: summaries,
    total_areas: SEED_AREA_SLUGS.length + customTotal,
    total_problems: counts.total,
    omitted: [
      ...omissions(counts, needs),
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
  const queue = await areaReviewQueue(db);
  const membership = `${VISIBLE} AND EXISTS (SELECT 1 FROM json_each(p.areas) a WHERE a.value = ?)`;
  const metadata = "length(trim(p.title)) > 0 AND v.problem_id IS NOT NULL";
  // Capture membership and current version/cursor together; then hydrate only
  // their verified public formulations, including the exact source notice.
  const [visibleResult, countResult, problemResult, reviewResult] = await db.batch([
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
    reviewMemberships(db, queue),
  ]);
  const needs = areaReviewNeeds(queue, reviewResult?.results as unknown as ReviewMembership[]);
  const visible = visibleResult?.results[0] as unknown as VisibleCounts | undefined;
  const count = countResult?.results[0] as unknown as
    | { total: number; missing: number }
    | undefined;
  if (!visible || !count) throw new Error("Area count unavailable");
  // A private-only or arbitrary other-* URL must not reveal a taxonomy entry.
  if (count.total === 0 && !SEED_AREA_SLUGS.some((known) => known === slug)) return null;
  const rename = await db
    .prepare(`SELECT new_title, event_id, created_at
    FROM area_rename_events WHERE area_slug = ? ORDER BY seq DESC LIMIT 1`)
    .bind(slug)
    .first<{ new_title: string; event_id: string; created_at: string }>();
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
      needs:
        needs.problems.get(row.id)?.cursor === row.public_seq
          ? (needs.problems.get(row.id)?.needs ?? [])
          : [],
    });
  }
  const unavailable = rows.length - problems.length;
  const remaining = count.total - count.missing - rows.length;

  return AreaDetailResponseSchema.parse({
    area: getAreaInfo(slug, count.total, needs.areas.get(slug) ?? [], rename ?? undefined),
    problems,
    omitted: [
      ...omissions(visible, needs),
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
