import {
  assertNoStatsAntiMetrics,
  type PlatformStatsFace,
  PlatformStatsFaceSchema,
  type StatsRate,
  UNAVAILABLE_UNTIL_DEPLOYED,
} from "../../../../packages/contracts/src/stats.ts";
import type { Env } from "../env.ts";
import { assertObservabilityBoundary } from "../observability/telemetry.ts";

type D1Database = NonNullable<Env["DB"]>;

function buildRate(numerator: number, denominator: number): StatsRate {
  const safeNum = Math.max(0, Math.trunc(numerator));
  const safeDen = Math.max(0, Math.trunc(denominator));
  const boundedNum = Math.min(safeNum, safeDen);
  if (safeDen === 0) {
    return { numerator: 0, denominator: 0, rate: null };
  }
  return {
    numerator: boundedNum,
    denominator: safeDen,
    rate: Math.round((boundedNum / safeDen) * 1_000_000) / 1_000_000,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1] ?? 0;
  const right = sorted[mid] ?? 0;
  return Math.round(((left + right) / 2) * 10_000) / 10_000;
}

async function listTables(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set((rows.results ?? []).map((row) => row.name));
}

async function listColumns(db: D1Database, table: string): Promise<Set<string>> {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((rows.results ?? []).map((row) => row.name));
}

async function scalarInt(db: D1Database, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number | null }>();
  const num = Number(row?.value ?? 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}

/**
 * Computes the live measured `/stats` face from bounded read-only D1 aggregate
 * queries covering all 5 Fable §13.3 health families.
 *
 * Strictly enforces Rule A10 / ADR-19 (zero actor names, zero leaderboards,
 * zero model-family rankings) via both Zod schema validation and
 * `assertNoStatsAntiMetrics`.
 */
export async function loadPlatformStats(
  db: D1Database,
  nowIso: string = new Date().toISOString(),
): Promise<PlatformStatsFace> {
  const tables = await listTables(db);
  const hasProblems = tables.has("problems");
  const hasSessions = tables.has("sessions");
  const hasFellows = tables.has("enrollment_fellows");
  const hasClaims = tables.has("claims");
  const hasReviews = tables.has("reviews");
  const hasEvidence = tables.has("evidence");
  const hasDeadEnds = tables.has("dead_ends");
  const hasIdempotency = tables.has("idempotency");
  const hasScreeningCases = tables.has("screening_cases");
  const hasReports = tables.has("reports");
  const hasAppeals = tables.has("screening_case_appeals");
  const hasRetractions = tables.has("retractions");

  const problemCols = hasProblems ? await listColumns(db, "problems") : new Set<string>();
  const hasProblemStatus = problemCols.has("status");
  const hasProblemSponsor = problemCols.has("sponsor_id");
  const hasProblemUnlisted = problemCols.has("unlisted");

  // 1. Collaboration family (strictly scoped to listed public problems per Rule A2)
  const publicProblemFilter = [
    hasProblemStatus ? "status <> 'private-draft'" : "1=1",
    hasProblemUnlisted ? "unlisted = 0" : "1=1",
  ].join(" AND ");
  const publicProblemFilterAliased = [
    hasProblemStatus ? "p.status <> 'private-draft'" : "1=1",
    hasProblemUnlisted ? "p.unlisted = 0" : "1=1",
  ].join(" AND ");
  const activeProblemFilter = hasProblemStatus
    ? `status IN ('active', 'sharpening', 'under-result-review') AND ${hasProblemUnlisted ? "unlisted = 0" : "1=1"}`
    : "1=1";
  const activeProblemFilterAliased = hasProblemStatus
    ? `p.status IN ('active', 'sharpening', 'under-result-review') AND ${hasProblemUnlisted ? "p.unlisted = 0" : "1=1"}`
    : "1=1";
  const publicScopedCount = (table: string, alias: string, extraWhere?: string): string => {
    if (hasProblems) {
      return `SELECT COUNT(*) AS value FROM ${table} ${alias} JOIN problems p ON p.id = ${alias}.problem_id WHERE ${publicProblemFilterAliased}${extraWhere ? ` AND (${extraWhere})` : ""}`;
    }
    return `SELECT COUNT(*) AS value FROM ${table} ${alias}${extraWhere ? ` WHERE ${extraWhere}` : ""}`;
  };

  const publicProblems = hasProblems
    ? await scalarInt(db, `SELECT COUNT(*) AS value FROM problems WHERE ${publicProblemFilter}`)
    : 0;
  const activeProblems = hasProblems
    ? await scalarInt(db, `SELECT COUNT(*) AS value FROM problems WHERE ${activeProblemFilter}`)
    : 0;

  let multiSponsorActiveProblems = 0;
  const firstExternalHours: number[] = [];
  if (hasProblems && hasSessions && hasFellows) {
    const multiRows = await db
      .prepare(
        `SELECT p.id, COUNT(DISTINCT f.sponsor_id) AS sponsor_count
         FROM problems p
         JOIN sessions s ON s.problem_id = p.id
         JOIN enrollment_fellows f ON f.fellow_id = s.fellow_id
         WHERE ${activeProblemFilterAliased}
         GROUP BY p.id
         LIMIT 500`,
      )
      .all<{ id: string; sponsor_count: number }>();
    multiSponsorActiveProblems = (multiRows.results ?? []).filter(
      (r) => Number(r.sponsor_count) >= 2,
    ).length;

    if (hasProblemSponsor) {
      const extRows = await db
        .prepare(
          `SELECT p.created_at AS problem_created_at, MIN(s.opened_at) AS first_ext_at
           FROM problems p
           JOIN sessions s ON s.problem_id = p.id
           JOIN enrollment_fellows f ON f.fellow_id = s.fellow_id
           WHERE ${publicProblemFilterAliased}
             AND p.sponsor_id IS NOT NULL
             AND f.sponsor_id <> p.sponsor_id
           GROUP BY p.id
           LIMIT 500`,
        )
        .all<{ problem_created_at: string; first_ext_at: string }>();
      for (const row of extRows.results ?? []) {
        const start = Date.parse(row.problem_created_at);
        const firstExt = Date.parse(row.first_ext_at);
        if (Number.isFinite(start) && Number.isFinite(firstExt) && firstExt >= start) {
          firstExternalHours.push((firstExt - start) / 3_600_000);
        }
      }
    }
  }

  const sessionsOpened = hasSessions ? await scalarInt(db, publicScopedCount("sessions", "s")) : 0;
  const sessionsClosed = hasSessions
    ? await scalarInt(db, publicScopedCount("sessions", "s", "s.closed_at IS NOT NULL"))
    : 0;
  const sessionsWithHandback = hasSessions
    ? await scalarInt(
        db,
        publicScopedCount(
          "sessions",
          "s",
          "s.closed_at IS NOT NULL AND s.handback IS NOT NULL AND length(trim(s.handback)) > 0",
        ),
      )
    : 0;

  // 2. Quality & Review-Supply Depth family (strictly scoped to listed public problems)
  const claimsTotal = hasClaims ? await scalarInt(db, publicScopedCount("claims", "c")) : 0;

  // Compute claim disposition distribution from recorded reviews/retractions/claims
  // (aggregate only, never per actor; assertion-only reviews without capable_of_failure move nothing per P5).
  const claimsByDisposition: Record<string, number> = {};
  let independentlyReviewedClaims = 0;
  let corroboratedAwaitingIndependence = 0;
  if (hasClaims) {
    const retractedWholeClaims = new Set<string>();
    if (hasRetractions) {
      const retractionRows = await db
        .prepare(
          hasProblems
            ? `SELECT r.problem_id, r.target_object
               FROM retractions r
               JOIN problems p ON p.id = r.problem_id
               WHERE ${publicProblemFilterAliased} AND instr(r.target_object, '@') = 0
               LIMIT 2000`
            : `SELECT problem_id, target_object
               FROM retractions
               WHERE instr(target_object, '@') = 0
               LIMIT 2000`,
        )
        .all<{ problem_id: string; target_object: string }>();
      for (const row of retractionRows.results ?? []) {
        retractedWholeClaims.add(`${row.problem_id}\u0000${row.target_object}`);
      }
    }

    if (hasReviews) {
      const reviewCols = await listColumns(db, "reviews");
      const substantiveCheck = reviewCols.has("capable_of_failure")
        ? "AND r.capable_of_failure IS NOT NULL AND length(trim(r.capable_of_failure)) > 0"
        : "";
      const claimReviewStats = await db
        .prepare(
          `SELECT c.problem_id, c.id,
                  SUM(CASE WHEN r.verdict IN ('confirm', 'reproduces') AND r.tier IN ('T2', 'T3') ${substantiveCheck} THEN 1 ELSE 0 END) AS high_tier_confirms,
                  SUM(CASE WHEN r.verdict IN ('confirm', 'reproduces') AND r.tier = 'T1' ${substantiveCheck} THEN 1 ELSE 0 END) AS t1_confirms,
                  SUM(CASE WHEN r.verdict IN ('refute', 'fails-to-reproduce') THEN 1 ELSE 0 END) AS refutes,
                  COUNT(r.review_id) AS total_reviews
           FROM claims c
           ${hasProblems ? `JOIN problems p ON p.id = c.problem_id` : ""}
           LEFT JOIN reviews r ON r.problem_id = c.problem_id AND r.target_claim_id = c.id
           ${hasProblems ? `WHERE ${publicProblemFilterAliased}` : ""}
           GROUP BY c.problem_id, c.id
           LIMIT 2000`,
        )
        .all<{
          problem_id: string;
          id: string;
          high_tier_confirms: number;
          t1_confirms: number;
          refutes: number;
          total_reviews: number;
        }>();
      for (const row of claimReviewStats.results ?? []) {
        const highConf = Number(row.high_tier_confirms ?? 0);
        const t1Conf = Number(row.t1_confirms ?? 0);
        const refutes = Number(row.refutes ?? 0);
        let bucket = "open";
        if (retractedWholeClaims.has(`${row.problem_id}\u0000${row.id}`)) {
          bucket = "retracted";
        } else if (refutes > 0 && highConf + t1Conf > 0) {
          bucket = "disputed";
        } else if (refutes > 0) {
          bucket = "refuted";
        } else if (highConf >= 2) {
          bucket = "strongly-supported";
        } else if (highConf >= 1 || t1Conf >= 1) {
          bucket = "corroborated";
          if (highConf === 0) corroboratedAwaitingIndependence += 1;
        }
        claimsByDisposition[bucket] = (claimsByDisposition[bucket] ?? 0) + 1;
        if (highConf > 0 || refutes > 0) {
          independentlyReviewedClaims += 1;
        }
      }
    } else if (claimsTotal > 0) {
      claimsByDisposition.open = claimsTotal;
    }
  }

  // Review-supply depth: distinct active Fellows with a DIFFERENT sponsor than the problem owner per active problem.
  const reviewSupplyDepths: number[] = [];
  if (hasProblems && hasFellows) {
    const fellowCols = await listColumns(db, "enrollment_fellows");
    const activeFellowClause = fellowCols.has("status") ? "f.status = 'active'" : "1=1";
    const problemRows = await db
      .prepare(
        `SELECT id, ${hasProblemSponsor ? "sponsor_id" : "NULL AS sponsor_id"}
         FROM problems
         WHERE ${activeProblemFilter}
         LIMIT 200`,
      )
      .all<{ id: string; sponsor_id: string | null }>();
    const fellowRows = await db
      .prepare(
        `SELECT sponsor_id, COUNT(*) AS fellow_count
         FROM enrollment_fellows f
         WHERE ${activeFellowClause}
         GROUP BY sponsor_id`,
      )
      .all<{ sponsor_id: string; fellow_count: number }>();
    const totalActiveFellows = (fellowRows.results ?? []).reduce(
      (sum, row) => sum + Number(row.fellow_count ?? 0),
      0,
    );
    const bySponsor = new Map<string, number>();
    for (const row of fellowRows.results ?? []) {
      bySponsor.set(row.sponsor_id, Number(row.fellow_count ?? 0));
    }
    for (const problem of problemRows.results ?? []) {
      const sameSponsor = problem.sponsor_id ? (bySponsor.get(problem.sponsor_id) ?? 0) : 0;
      reviewSupplyDepths.push(Math.max(0, totalActiveFellows - sameSponsor));
    }
  }

  let reproPass = 0;
  let reproFail = 0;
  if (hasEvidence) {
    reproPass += await scalarInt(
      db,
      publicScopedCount("evidence", "ev", "ev.direction = 'reproduces'"),
    );
    reproFail += await scalarInt(
      db,
      publicScopedCount("evidence", "ev", "ev.direction = 'fails-to-reproduce'"),
    );
  }
  if (hasReviews) {
    reproPass += await scalarInt(
      db,
      publicScopedCount("reviews", "rv", "rv.verdict = 'reproduces'"),
    );
    reproFail += await scalarInt(
      db,
      publicScopedCount("reviews", "rv", "rv.verdict = 'fails-to-reproduce'"),
    );
  }

  const deadEndsRecorded = hasDeadEnds
    ? await scalarInt(db, publicScopedCount("dead_ends", "de"))
    : 0;
  const deadEndsWithRetry = hasDeadEnds
    ? await scalarInt(
        db,
        publicScopedCount("dead_ends", "de", "length(trim(de.retry_predicate)) > 0"),
      )
    : 0;

  // 3. Ergonomics family (scoped to listed public problems per Rule A2)
  const idempotentWritesRecorded = hasIdempotency
    ? await scalarInt(db, publicScopedCount("idempotency", "idemp"))
    : 0;

  // 4. Comprehension family (supports both legacy reason labels and canonical POST /v1/reports `integrity`/`other` notes)
  let falseSolvedReportsRecorded = 0;
  if (hasReports) {
    const reportCols = await listColumns(db, "reports");
    const hasReportNote = reportCols.has("note");
    const hasReportProblemId = reportCols.has("problem_id");
    const falseSolvedPredicate = hasReportNote
      ? `(rp.reason IN ('false-solved', 'misleading-solved-claim') OR (rp.reason IN ('integrity', 'other') AND (lower(coalesce(rp.note, '')) LIKE '%false-solved%' OR lower(coalesce(rp.note, '')) LIKE '%false solved%' OR lower(coalesce(rp.note, '')) LIKE '%misleading%solved%')))`
      : `rp.reason IN ('false-solved', 'misleading-solved-claim')`;
    falseSolvedReportsRecorded = await scalarInt(
      db,
      hasProblems && hasReportProblemId
        ? publicScopedCount("reports", "rp", falseSolvedPredicate)
        : `SELECT COUNT(*) AS value FROM reports rp WHERE ${falseSolvedPredicate}`,
    );
  }

  // 5. Safety family
  const quarantineCasesOpen = hasScreeningCases
    ? await scalarInt(db, "SELECT COUNT(*) AS value FROM screening_cases WHERE state = 'pending'")
    : 0;
  const quarantineCasesResolved = hasScreeningCases
    ? await scalarInt(
        db,
        "SELECT COUNT(*) AS value FROM screening_cases WHERE state IN ('released', 'rejected')",
      )
    : 0;
  const screeningAppealsTotal = hasAppeals
    ? await scalarInt(db, "SELECT COUNT(*) AS value FROM screening_case_appeals")
    : 0;
  const screeningAppealReversals = hasAppeals
    ? await scalarInt(
        db,
        "SELECT COUNT(*) AS value FROM screening_case_appeals WHERE state = 'released'",
      )
    : 0;
  const screeningAppealsDecided = hasAppeals
    ? await scalarInt(
        db,
        "SELECT COUNT(*) AS value FROM screening_case_appeals WHERE state IN ('released', 'upheld')",
      )
    : 0;

  const face: PlatformStatsFace = PlatformStatsFaceSchema.parse({
    kind: "stats",
    state: "measured",
    contract_version: 2,
    measured_at: nowIso,
    storage_authority: "d1",
    anti_metrics_policy: "rule-a10-no-actor-rankings-no-model-comparisons",
    license: "CC-BY-4.0",
    collaboration: {
      public_problems: publicProblems,
      active_problems: activeProblems,
      active_problems_with_multiple_sponsors: multiSponsorActiveProblems,
      multi_sponsor_active_problem_share: buildRate(multiSponsorActiveProblems, activeProblems),
      median_hours_to_first_external_sponsor: median(firstExternalHours),
      first_external_sponsor_sample_size: firstExternalHours.length,
      handback_completion_rate: buildRate(sessionsWithHandback, sessionsClosed),
    },
    quality: {
      claims_total: claimsTotal,
      claims_by_disposition: claimsByDisposition,
      consequential_claims_independent_review_coverage: buildRate(
        independentlyReviewedClaims,
        claimsTotal,
      ),
      review_supply_depth: {
        problems_measured: reviewSupplyDepths.length,
        median_eligible_independent_fellows: median(reviewSupplyDepths),
        min_eligible_independent_fellows:
          reviewSupplyDepths.length === 0 ? null : Math.min(...reviewSupplyDepths),
      },
      corroborated_awaiting_independence_count: corroboratedAwaitingIndependence,
      reproduction_pass_rate: buildRate(reproPass, reproPass + reproFail),
      dead_ends_recorded: deadEndsRecorded,
      dead_ends_with_retry_predicate: deadEndsWithRetry,
    },
    ergonomics: {
      sessions_opened: sessionsOpened,
      sessions_closed: sessionsClosed,
      idempotent_writes_recorded: idempotentWritesRecorded,
      onboarding_completion_by_harness: UNAVAILABLE_UNTIL_DEPLOYED,
      median_paste_to_orient_seconds: UNAVAILABLE_UNTIL_DEPLOYED,
      tokens_per_useful_action: UNAVAILABLE_UNTIL_DEPLOYED,
      protocol_errors_by_client_version: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    comprehension: {
      false_solved_reports_recorded: falseSolvedReportsRecorded,
      usability_status_identification_rate: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    safety: {
      quarantine_cases_open: quarantineCasesOpen,
      quarantine_cases_resolved: quarantineCasesResolved,
      screening_appeals_total: screeningAppealsTotal,
      screening_appeal_reversals: screeningAppealReversals,
      screening_appeal_reversal_rate: buildRate(screeningAppealReversals, screeningAppealsDecided),
      hosted_screening_fp_fn_status: UNAVAILABLE_UNTIL_DEPLOYED,
      edge_cache_hit_ratio: UNAVAILABLE_UNTIL_DEPLOYED,
    },
    omitted: [
      "actor names, leaderboards, streaks, and model-family comparisons are omitted by Rule A10 / ADR-19",
      "private workshop drafts, sponsor directives, and unlisted/private-draft problems are excluded by Rule A2",
      "external edge-cache, Sentry, usability, and hosted Workers AI telemetry remain unavailable_until_deployed",
    ],
    next_actions: [
      { method: "GET", path: "/capabilities", why: "The live surface of this deployment." },
      { method: "GET", path: "/problems.md", why: "Public problems and their current state." },
      { method: "GET", path: "/moves.md", why: "Highest-leverage open scientific moves." },
      {
        method: "GET",
        path: "/reviews.md",
        why: "Public review queue awaiting independent checks.",
      },
    ],
  });

  assertNoStatsAntiMetrics(face);
  assertObservabilityBoundary("public-stats", face);
  return face;
}
