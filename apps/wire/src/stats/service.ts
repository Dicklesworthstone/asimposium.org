import {
  assertNoStatsAntiMetrics,
  type PlatformStatsFace,
  PlatformStatsFaceSchema,
  type StatsRate,
  UNAVAILABLE_UNTIL_DEPLOYED,
} from "../../../../packages/contracts/src/stats.ts";
import type { Env } from "../env.ts";
import {
  eventContentHiddenSql,
  PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL,
} from "../krater/public-content.ts";
import { ScientificInputError } from "../ledger/scientific-checks.ts";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificRow,
} from "../ledger/scientific-disposition.ts";
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

// A stats request can fold at most 16 current public claim histories. Lookahead
// is unnecessary: the exact public total and selection share one SQL snapshot.
// Anything outside the bounded sample remains explicitly unassessed.
const STATS_CLAIM_LIMIT = 16;
const STATS_HISTORY_BUDGET = {
  maxRows: 128,
  maxPayloadBytes: 16 * 1024,
  maxTotalPayloadBytes: 128 * 1024,
};

async function measureClaimStandings(db: D1Database, tables: ReadonlySet<string>) {
  if (!tables.has("claims")) throw new Error("The public claim inventory is unavailable.");
  const result = {
    total: 0,
    assessed: 0,
    independentlyReviewed: 0,
    awaitingIndependence: 0,
    buckets: {} as Record<string, number>,
  };
  // A legacy projection can measure its inventory, but cannot establish
  // standing from review rows without the digest-bound event history.
  if (!tables.has("events") && !tables.has("event_content") && !tables.has("content_controls")) {
    result.total = await scalarInt(
      db,
      `SELECT COUNT(*) AS value FROM claims
      JOIN problems p ON p.id = claims.problem_id
      WHERE p.status <> 'private-draft' AND p.unlisted = 0`,
    );
    if (result.total) result.buckets.unassessed = result.total;
    return result;
  }

  const selected = await db
    .prepare(`SELECT claims.problem_id, claims.id, p.public_seq,
      publication.object_version AS version, COUNT(*) OVER () AS total
    FROM claims JOIN problems p ON p.id = claims.problem_id
    JOIN events publication ON publication.problem_id = claims.problem_id AND publication.seq = claims.source_seq
    WHERE p.status <> 'private-draft' AND p.unlisted = 0 AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
    ORDER BY claims.problem_id, claims.id LIMIT ?`)
    .bind(STATS_CLAIM_LIMIT)
    .all<{ problem_id: string; id: string; public_seq: number; version: number; total: number }>();
  if (!selected.success) throw new Error("The public claim inventory is unavailable.");
  result.total = selected.results[0]?.total ?? 0;
  for (const head of selected.results) {
    const history = await prepareScientificDispositions(
      db,
      head.problem_id,
      head.public_seq,
      1,
      { claimId: head.id, version: head.version },
      STATS_HISTORY_BUDGET,
    ).all<ScientificRow>();
    if (!history.success) throw new Error("Scientific history is unavailable.");
    try {
      const fold = await foldScientificRows(
        history.results.filter((row) => row.target_version <= head.version),
      );
      if (fold.currentVersion !== head.version || fold.stale) continue;
      result.assessed++;
      result.buckets[fold.disposition] = (result.buckets[fold.disposition] ?? 0) + 1;
      const independentReviews = fold.context.verified_reviews.filter(
        (review) => review.tier === "T2" || review.tier === "T3",
      );
      if (independentReviews.length > 0) result.independentlyReviewed++;
      if (
        fold.disposition === "corroborated" &&
        !independentReviews.some((review) => review.finding === "support")
      )
        result.awaitingIndependence++;
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
    }
  }
  if (result.assessed < result.total) result.buckets.unassessed = result.total - result.assessed;
  return result;
}

/** Count public scientific outcomes at the published cursor. A retained
 * projection can outlive both its source and the exact statement it reviews. */
async function measurePublicOutcomes(db: D1Database) {
  const row = await db
    .prepare(`WITH sources AS (
    SELECT e.problem_id, e.seq, e.object_kind,
      CASE WHEN json_valid(c.payload_json) THEN c.payload_json END AS body
    FROM events e JOIN problems p ON p.id = e.problem_id
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    WHERE p.status <> 'private-draft' AND p.unlisted = 0 AND e.seq <= p.public_seq
      AND ((e.type = 'review.created' AND e.object_kind = 'review')
        OR (e.type = 'evidence.created' AND e.object_kind = 'evidence')
        OR (e.type = 'dead_end.recorded' AND e.object_kind = 'dead_end'))
      AND e.object_version = 1 AND c.redacted_at IS NULL
      AND NOT ${eventContentHiddenSql("e")}
  ), outcomes AS (
    SELECT *, CASE object_kind WHEN 'review' THEN 'claim'
        ELSE json_extract(body, '$.bears_on_kind') END AS target_kind,
      CASE object_kind WHEN 'review' THEN json_extract(body, '$.target_claim_id')
        ELSE json_extract(body, '$.bears_on_id') END AS target_id,
      CASE object_kind WHEN 'review' THEN json_extract(body, '$.target_version')
        ELSE json_extract(body, '$.bears_on_version') END AS target_version,
      CASE object_kind WHEN 'review' THEN json_extract(body, '$.verdict')
        ELSE json_extract(body, '$.direction') END AS outcome
    FROM sources WHERE body IS NOT NULL
  )
  SELECT COUNT(*) FILTER (WHERE outcome = 'reproduces' AND object_kind <> 'dead_end') AS passed,
    COUNT(*) FILTER (WHERE outcome = 'fails-to-reproduce' AND object_kind <> 'dead_end') AS failed,
    COUNT(*) FILTER (WHERE object_kind = 'dead_end') AS dead_ends,
    COUNT(*) FILTER (WHERE object_kind = 'dead_end'
      AND json_type(body, '$.retry_predicate') = 'text'
      AND length(trim(json_extract(body, '$.retry_predicate'))) > 0) AS with_retry
  FROM outcomes o
  WHERE object_kind = 'dead_end' OR (outcome IN ('reproduces', 'fails-to-reproduce') AND EXISTS (
    SELECT 1 FROM events target JOIN event_content tc ON tc.event_id = target.id
      AND tc.payload_sha256 = target.payload_sha256 AND tc.redacted_at IS NULL
    WHERE target.problem_id = o.problem_id AND target.seq < o.seq
      AND target.object_kind = o.target_kind AND target.object_id = o.target_id
      AND ((target.object_kind = 'claim' AND target.object_version = o.target_version
          AND ((target.type = 'claim.created' AND target.object_version = 1)
            OR (target.type = 'claim.revised' AND target.object_version > 1)))
        OR (target.object_kind = 'hypothesis' AND target.type = 'hypothesis.created'
          AND target.object_version = 1 AND o.target_version IS NULL))
      AND json_valid(tc.payload_json) AND NOT ${eventContentHiddenSql("target")}
  ))`)
    .first<{ passed: number; failed: number; dead_ends: number; with_retry: number }>();
  if (!row) throw new Error("Public scientific outcomes are unavailable.");
  return row;
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
  const hasReviews = tables.has("reviews");
  const hasEvidence = tables.has("evidence");
  const hasDeadEnds = tables.has("dead_ends");
  const hasIdempotency = tables.has("idempotency");
  const hasScreeningCases = tables.has("screening_cases");
  const hasSponsorScreeningCases = tables.has("sponsor_screening_cases");
  const hasReports = tables.has("reports");
  const hasAppeals = tables.has("screening_case_appeals");
  const hasSponsorAppeals = tables.has("sponsor_screening_case_appeals");

  const problemCols = hasProblems ? await listColumns(db, "problems") : new Set<string>();
  const hasProblemStatus = problemCols.has("status");
  const hasProblemSponsor = problemCols.has("sponsor_id");
  const hasProblemUnlisted = problemCols.has("unlisted");

  if (!hasProblems || !hasProblemStatus || !hasProblemUnlisted) {
    throw new Error("Public problem visibility is unavailable.");
  }

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
  const science = await measureClaimStandings(db, tables);
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
  let deadEndsRecorded = 0;
  let deadEndsWithRetry = 0;
  if (tables.has("events") || tables.has("event_content") || tables.has("content_controls")) {
    const outcomes = await measurePublicOutcomes(db);
    reproPass = outcomes.passed;
    reproFail = outcomes.failed;
    deadEndsRecorded = outcomes.dead_ends;
    deadEndsWithRetry = outcomes.with_retry;
  } else {
    // Pre-ledger databases retain their legacy aggregate projection.
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

    deadEndsRecorded = hasDeadEnds ? await scalarInt(db, publicScopedCount("dead_ends", "de")) : 0;
    deadEndsWithRetry = hasDeadEnds
      ? await scalarInt(
          db,
          publicScopedCount("dead_ends", "de", "length(trim(de.retry_predicate)) > 0"),
        )
      : 0;
  }

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
  const quarantineCasesOpen =
    (hasScreeningCases
      ? await scalarInt(db, "SELECT COUNT(*) AS value FROM screening_cases WHERE state = 'pending'")
      : 0) +
    (hasSponsorScreeningCases
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM sponsor_screening_cases WHERE state = 'pending'",
        )
      : 0);
  const quarantineCasesResolved =
    (hasScreeningCases
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM screening_cases WHERE state IN ('released', 'rejected')",
        )
      : 0) +
    (hasSponsorScreeningCases
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM sponsor_screening_cases WHERE state IN ('released', 'rejected')",
        )
      : 0);
  const screeningAppealsTotal =
    (hasAppeals ? await scalarInt(db, "SELECT COUNT(*) AS value FROM screening_case_appeals") : 0) +
    (hasSponsorAppeals
      ? await scalarInt(db, "SELECT COUNT(*) AS value FROM sponsor_screening_case_appeals")
      : 0);
  const screeningAppealReversals =
    (hasAppeals
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM screening_case_appeals WHERE state = 'released'",
        )
      : 0) +
    (hasSponsorAppeals
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM sponsor_screening_case_appeals WHERE state = 'released'",
        )
      : 0);
  const screeningAppealsDecided =
    (hasAppeals
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM screening_case_appeals WHERE state IN ('released', 'upheld')",
        )
      : 0) +
    (hasSponsorAppeals
      ? await scalarInt(
          db,
          "SELECT COUNT(*) AS value FROM sponsor_screening_case_appeals WHERE state IN ('released', 'upheld')",
        )
      : 0);

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
      claims_total: science.total,
      claims_by_disposition: science.buckets,
      consequential_claims_independent_review_coverage: buildRate(
        science.independentlyReviewed,
        science.assessed,
      ),
      review_supply_depth: {
        problems_measured: reviewSupplyDepths.length,
        median_eligible_independent_fellows: median(reviewSupplyDepths),
        min_eligible_independent_fellows:
          reviewSupplyDepths.length === 0 ? null : Math.min(...reviewSupplyDepths),
      },
      corroborated_awaiting_independence_count: science.awaitingIndependence,
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
      ...(science.assessed < science.total
        ? [
            "Standing checks cover up to 16 claims ordered by problem and claim id. Review coverage and corroborated-awaiting-independence counts cover assessed claims only.",
          ]
        : []),
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
