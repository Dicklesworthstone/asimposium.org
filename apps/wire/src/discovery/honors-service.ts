import {
  encodeNowPageCursor,
  type HonorsCarryingReviewer,
  type HonorsContributingFellow,
  type HonorsDagContext,
  type HonorsGatedStatus,
  type HonorsItem,
  type HonorsQuery,
  HonorsQuerySchema,
  type HonorsResponse,
  HonorsResponseSchema,
  parseNowPageCursor,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";
import {
  checkedScientificPayload,
  recordedReviewIndependence,
  ScientificInputError,
} from "../ledger/scientific-checks.ts";
import { readScientificDispositions } from "../ledger/scientific-disposition.ts";

interface ProblemRow {
  id: string;
  title: string;
  status: string;
  public_seq: number;
  created_at: string;
}

interface CursorRow {
  cursor: number;
}

interface ClaimContentRow {
  claim_id: string;
  version: number;
  statement: string;
  kind: string;
  editor_fellow_id: string;
  actor_sponsor_id: string;
  fellow_name: string | null;
  model: string | null;
  harness: string | null;
  payload_json: string;
  payload_sha256: string;
  created_at: string;
  seq: number;
}

interface ReviewContentRow {
  review_id: string;
  reviewer_fellow_id: string;
  reviewer_name: string | null;
  reviewer_sponsor_id: string;
  author_sponsor_at_event: string;
  event_id: string;
  seq: number;
  created_at: string;
  payload_json: string;
  payload_sha256: string;
}

async function safePayload(row: {
  payload_json: string;
  payload_sha256: string;
}): Promise<Record<string, unknown> | null> {
  try {
    return await checkedScientificPayload(row);
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
}

function sanitizeFellowName(name: string | null | undefined, fallbackId: string): string {
  if (name && /^[a-z][a-z0-9-]{2,31}$/.test(name)) {
    return name;
  }
  const candidate = fallbackId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[a-z][a-z0-9-]{2,31}$/.test(candidate)) {
    return candidate;
  }
  return "unnamed-fellow";
}

/**
 * Load the chronological honors record (/results).
 *
 * Gated mechanically on (Fable §9.5, Rule A10, ADR-19):
 *  - claims that reached "machine-checked"
 *  - claims that reached "strongly-supported"
 *  - problems that reached "resolved"
 *
 * Strictly event-ordered, never actor-aggregated.
 */
export async function loadHonorsRecord(
  db: D1Database,
  query: HonorsQuery = {},
): Promise<HonorsResponse> {
  const parsedQuery = HonorsQuerySchema.parse(query);
  const boundary =
    parsedQuery.before === undefined ? undefined : parseNowPageCursor(parsedQuery.before);
  if (parsedQuery.before !== undefined && boundary === undefined) {
    throw new Error("Invalid Honors cursor");
  }

  const cursorRow = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<CursorRow>();
  if (!cursorRow) throw new Error("Public cursor unavailable");
  const cursor = cursorRow.cursor;

  const candidateItems: HonorsItem[] = [];

  // Query public, listed problems
  const problems = await db
    .prepare(
      `SELECT id, title, status, public_seq, created_at
       FROM problems
       WHERE status != 'private-draft' AND unlisted = 0
       ORDER BY public_seq DESC`,
    )
    .all<ProblemRow>();

  for (const prob of problems.results ?? []) {
    // 1. Check if problem itself reached resolved status
    if (prob.status === "resolved") {
      // Find event where problem was resolved or sequence head
      const resolveEvent = await db
        .prepare(
          `SELECT id, seq, created_at, actor_fellow_id, actor_sponsor_id
           FROM events
           WHERE problem_id = ? AND (type = 'problem.resolved' OR seq = ?)
           ORDER BY seq DESC LIMIT 1`,
        )
        .bind(prob.id, prob.public_seq)
        .first<{
          id: string;
          seq: number;
          created_at: string;
          actor_fellow_id: string | null;
          actor_sponsor_id: string | null;
        }>();

      if (resolveEvent) {
        // Contributing fellows: actors who authored claims or problem events
        const contributors = await db
          .prepare(
            `SELECT DISTINCT e.actor_fellow_id, e.actor_sponsor_id, f.name, f.model, f.harness
             FROM events e
             LEFT JOIN enrollment_fellows f ON f.fellow_id = e.actor_fellow_id
             WHERE e.problem_id = ? AND e.seq <= ? AND e.actor_fellow_id IS NOT NULL AND e.actor_sponsor_id IS NOT NULL
             LIMIT 10`,
          )
          .bind(prob.id, prob.public_seq)
          .all<{
            actor_fellow_id: string;
            actor_sponsor_id: string;
            name: string | null;
            model: string | null;
            harness: string | null;
          }>();

        const contributingFellows: HonorsContributingFellow[] = (contributors.results ?? []).map(
          (c) => ({
            fellow_id: c.actor_fellow_id,
            name: sanitizeFellowName(c.name, c.actor_fellow_id),
            sponsor_id: c.actor_sponsor_id,
            model: c.model ?? "unknown",
            model_provenance: "self_declared",
            harness: c.harness ?? "unknown",
            harness_provenance: "self_declared",
          }),
        );

        if (
          contributingFellows.length === 0 &&
          resolveEvent.actor_fellow_id &&
          resolveEvent.actor_sponsor_id
        ) {
          contributingFellows.push({
            fellow_id: resolveEvent.actor_fellow_id,
            name: sanitizeFellowName(null, resolveEvent.actor_fellow_id),
            sponsor_id: resolveEvent.actor_sponsor_id,
            model: "unknown",
            model_provenance: "self_declared",
            harness: "unknown",
            harness_provenance: "self_declared",
          });
        }

        if (contributingFellows.length > 0) {
          candidateItems.push({
            kind: "problem",
            result_id: prob.id,
            problem_id: prob.id,
            settled_at: resolveEvent.created_at,
            sequence: resolveEvent.seq,
            status: "resolved",
            title: prob.title?.trim() || prob.id,
            contributing_fellows: contributingFellows,
            carrying_reviewers: [],
            dag_context: {
              depends_on: [],
              unlocks: [],
              closes_gaps: [],
            },
            evidence_trail: [],
          });
        }
      }
    }

    // 2. Check claims within this problem
    const dispositions = await readScientificDispositions(db, prob.id, prob.public_seq, 100);

    const claimRowsInProblem = await db
      .prepare(
        `SELECT id FROM claims WHERE problem_id = ? AND source_seq <= ? ORDER BY source_seq ASC`,
      )
      .bind(prob.id, prob.public_seq)
      .all<{ id: string }>();

    const claimIdsToCheck = [
      ...new Set([...dispositions.keys(), ...(claimRowsInProblem.results ?? []).map((r) => r.id)]),
    ];

    for (const claimId of claimIdsToCheck) {
      const fold = dispositions.get(claimId);
      const isMachineChecked = fold?.context.has_certified_artifact ?? false;

      // Honors follow the computed disposition only (ADR-9). A parallel
      // evaluator here once honored a claim from any surviving check on the
      // problem plus one plain confirm, which let another claim's check be
      // borrowed. The disposition fold scopes evidence to the claim.
      const isStronglySupported = fold?.disposition === "strongly-supported";

      if (!isMachineChecked && !isStronglySupported) {
        continue;
      }

      const status: HonorsGatedStatus = isMachineChecked ? "machine-checked" : "strongly-supported";
      const targetVersion = fold?.currentVersion ?? 1;

      // Fetch claim content and initial attribution
      const claimRow = await db
        .prepare(
          `SELECT
             cv.claim_id,
             cv.version,
             cv.statement,
             cv.kind,
             cv.editor_fellow_id,
             e.actor_sponsor_id,
             f.name as fellow_name,
             f.model,
             f.harness,
             content.payload_json,
             content.payload_sha256,
             e.created_at,
             e.seq
           FROM claim_versions cv
           JOIN events e
             ON e.problem_id = cv.problem_id
            AND e.object_id = cv.claim_id
            AND e.object_version = cv.version
            AND e.object_kind = 'claim'
            AND e.type IN ('claim.created', 'claim.revised')
           JOIN event_content content
             ON content.event_id = e.id
            AND content.payload_sha256 = e.payload_sha256
            AND content.redacted_at IS NULL
           JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq
           LEFT JOIN enrollment_fellows f
             ON f.fellow_id = cv.editor_fellow_id
           WHERE cv.problem_id = ? AND cv.claim_id = ? AND cv.version = ?`,
        )
        .bind(prob.id, claimId, targetVersion)
        .first<ClaimContentRow>();

      if (!claimRow) continue;
      const claimPayload = await safePayload(claimRow);
      if (!claimPayload) continue;

      const contributingFellows: HonorsContributingFellow[] = [
        {
          fellow_id: claimRow.editor_fellow_id,
          name: sanitizeFellowName(claimRow.fellow_name, claimRow.editor_fellow_id),
          sponsor_id: claimRow.actor_sponsor_id,
          model: claimRow.model ?? "unknown",
          model_provenance: "self_declared",
          harness: claimRow.harness ?? "unknown",
          harness_provenance: "self_declared",
        },
      ];

      // Query supporting reviews
      const reviewRows = await db
        .prepare(
          `SELECT
             r.review_id,
             r.reviewer_fellow_id,
             f.name as reviewer_name,
             e.actor_sponsor_id as reviewer_sponsor_id,
             author.actor_sponsor_id as author_sponsor_at_event,
             e.id as event_id,
             e.seq,
             e.created_at,
             content.payload_json,
             content.payload_sha256
           FROM reviews r
           JOIN events e
             ON e.id = r.source_event_id
            AND e.seq <= ?
            AND e.object_id = r.review_id
            AND e.object_kind = 'review'
            AND e.type = 'review.created'
            AND e.actor_sponsor_id IS NOT NULL
           JOIN event_content content
             ON content.event_id = e.id
            AND content.payload_sha256 = e.payload_sha256
            AND content.redacted_at IS NULL
           JOIN events author
             ON author.problem_id = r.problem_id
            AND author.object_id = r.target_claim_id
            AND author.object_version = r.target_version
            AND author.object_kind = 'claim'
            AND author.type IN ('claim.created', 'claim.revised')
            AND author.seq < e.seq
            AND author.actor_sponsor_id IS NOT NULL
           LEFT JOIN enrollment_fellows f
             ON f.fellow_id = r.reviewer_fellow_id
           WHERE r.problem_id = ?
             AND r.target_claim_id = ?
             AND r.target_version = ?
             AND r.verdict IN ('confirm', 'reproduces', 'corroborates')
           ORDER BY e.seq ASC`,
        )
        .bind(prob.public_seq, prob.id, claimId, targetVersion)
        .all<ReviewContentRow>();

      const carryingReviewers: HonorsCarryingReviewer[] = [];
      let lastSettlingTime = claimRow.created_at;
      let lastSettlingSeq = claimRow.seq;

      for (const r of reviewRows.results ?? []) {
        const payload = await safePayload(r);
        if (!payload || typeof payload.basis !== "string") continue;
        const { tier } = recordedReviewIndependence(
          payload,
          r.author_sponsor_at_event,
          r.reviewer_sponsor_id,
        );
        if (tier === "T0") continue; // Only independent reviews (T1, T2, T3) carry settlement

        carryingReviewers.push({
          fellow_id: r.reviewer_fellow_id,
          name: sanitizeFellowName(r.reviewer_name, r.reviewer_fellow_id),
          sponsor_id: r.reviewer_sponsor_id,
          tier,
          verdict: typeof payload.verdict === "string" ? payload.verdict : "confirm",
          basis: payload.basis.slice(0, 500),
        });

        if (r.seq > lastSettlingSeq) {
          lastSettlingSeq = r.seq;
          lastSettlingTime = r.created_at;
        }
      }

      // Query DAG context
      const depsRows = await db
        .prepare(
          `SELECT depends_on_claim_id
           FROM claim_deps
           WHERE problem_id = ? AND claim_id = ?
           ORDER BY depends_on_claim_id ASC`,
        )
        .bind(prob.id, claimId)
        .all<{ depends_on_claim_id: string }>();
      const dependsOn = (depsRows.results ?? []).map((r) => r.depends_on_claim_id);

      const unlocksRows = await db
        .prepare(
          `SELECT claim_id
           FROM claim_deps
           WHERE problem_id = ? AND depends_on_claim_id = ?
           ORDER BY claim_id ASC`,
        )
        .bind(prob.id, claimId)
        .all<{ claim_id: string }>();
      const unlocks = (unlocksRows.results ?? []).map((r) => r.claim_id);

      const relationsRows = await db
        .prepare(
          `SELECT target_ref
           FROM claim_relations
           WHERE problem_id = ? AND source_claim_id = ? AND kind = 'addresses-gap'
           ORDER BY target_ref ASC`,
        )
        .bind(prob.id, claimId)
        .all<{ target_ref: string }>();

      const gapsRows = await db
        .prepare(
          `SELECT gap_id
           FROM proof_gaps
           WHERE problem_id = ? AND closed_by = ?
           ORDER BY gap_id ASC`,
        )
        .bind(prob.id, claimId)
        .all<{ gap_id: string }>();

      const closesGaps = [
        ...new Set([
          ...(relationsRows.results ?? []).map((r) => r.target_ref),
          ...(gapsRows.results ?? []).map((r) => r.gap_id),
        ]),
      ].sort();

      const evidenceRows = await db
        .prepare(
          `SELECT DISTINCT object_id
           FROM events
           WHERE problem_id = ? AND object_kind = 'evidence' AND seq <= ?
           ORDER BY seq ASC LIMIT 5`,
        )
        .bind(prob.id, lastSettlingSeq)
        .all<{ object_id: string }>();
      const evidenceTrail = (evidenceRows.results ?? []).map((r) => r.object_id);

      candidateItems.push({
        kind: "claim",
        result_id: claimId,
        problem_id: prob.id,
        settled_at: lastSettlingTime,
        sequence: lastSettlingSeq,
        status,
        title:
          typeof claimPayload.statement === "string" && claimPayload.statement.trim().length > 0
            ? claimPayload.statement.trim().slice(0, 300)
            : claimRow.statement?.trim().slice(0, 300) || claimId,
        statement:
          typeof claimPayload.statement === "string" ? claimPayload.statement : claimRow.statement,
        contributing_fellows: contributingFellows,
        carrying_reviewers: carryingReviewers,
        dag_context: {
          depends_on: dependsOn,
          unlocks,
          closes_gaps: closesGaps,
        },
        evidence_trail: evidenceTrail,
      });
    }
  }

  // Strictly chronological ordering (event-ordered, never actor-aggregated)
  candidateItems.sort((a, b) => {
    if (a.settled_at !== b.settled_at) {
      return a.settled_at < b.settled_at ? 1 : -1;
    }
    if (a.problem_id !== b.problem_id) {
      return a.problem_id < b.problem_id ? -1 : 1;
    }
    if (a.sequence !== b.sequence) {
      return b.sequence - a.sequence;
    }
    return a.result_id < b.result_id ? -1 : 1;
  });

  // Apply cursor boundary if present
  let filteredItems = candidateItems;
  if (boundary !== undefined) {
    const [boundTime, boundProblem, boundSeq, boundId] = [
      boundary[1],
      boundary[2],
      boundary[3],
      boundary[4],
    ];
    filteredItems = candidateItems.filter((item) => {
      if (item.settled_at < boundTime) return true;
      if (item.settled_at > boundTime) return false;
      if (item.problem_id > boundProblem) return true;
      if (item.problem_id < boundProblem) return false;
      if (item.sequence < boundSeq) return true;
      if (item.sequence > boundSeq) return false;
      return item.result_id > boundId;
    });
  }

  const PAGE_LIMIT = 50;
  const pageItems = filteredItems.slice(0, PAGE_LIMIT);
  let nextBefore: string | undefined;

  if (filteredItems.length > PAGE_LIMIT) {
    const lastItem = filteredItems[PAGE_LIMIT - 1];
    if (lastItem) {
      nextBefore = encodeNowPageCursor({
        created_at: lastItem.settled_at,
        problem_id: lastItem.problem_id,
        seq: lastItem.sequence,
        event_id: lastItem.result_id,
      });
    }
  }

  // OPS.2a structured diagnostic logging
  const publicActors = [
    ...new Set(pageItems.flatMap((i) => i.contributing_fellows.map((f) => f.fellow_id))),
  ].sort();
  const publicSponsors = [
    ...new Set(pageItems.flatMap((i) => i.contributing_fellows.map((f) => f.sponsor_id))),
  ].sort();
  const eligibilityDigest = await sha256Hex(
    JSON.stringify(pageItems.map((i) => ({ id: i.result_id, status: i.status }))),
  );

  console.log(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "honors-feed",
      cursor,
      results_count: pageItems.length,
      public_actors: publicActors,
      public_sponsors: publicSponsors,
      recompute_version: "v1",
      eligibility_digest: eligibilityDigest,
      has_more: nextBefore !== undefined,
    }),
  );

  return HonorsResponseSchema.parse({
    results: pageItems,
    cursor,
    ...(nextBefore !== undefined ? { next_before: nextBefore } : {}),
    omitted: [
      "private and unlisted problems are excluded from honors records",
      "results are event-ordered, never actor-aggregated (Rule A10 / ADR-19)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
      "token-contribution accounting and value-vote metrics permanently refused (ADR-19)",
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      ...(nextBefore !== undefined
        ? ["older honors results are available through next_before"]
        : []),
    ],
  });
}
