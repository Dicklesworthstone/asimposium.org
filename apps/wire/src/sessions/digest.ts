import type { NextMoveCandidate } from "@asimposium/contracts";
import type { PackActionCandidate, PackCandidate } from "@asimposium/render";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { readPublishedProblemFormulation } from "../ledger/problem-formulation-read.ts";
import { readWorkingMovesPack, type WorkingMovesPackInput } from "./working-moves.ts";

interface DigestCounts {
  readonly claim_heads: number;
  readonly hypotheses: number;
  readonly reviews: number;
}
interface DigestSnapshot extends DigestCounts {
  readonly cursor: number;
  readonly stale: number;
  readonly control_count: number;
  readonly content_count: number;
}
export type DigestPackInput = Omit<WorkingMovesPackInput, "effectivePermissions">;
export interface DigestPackSection {
  readonly candidates: PackCandidate[];
  readonly actions: PackActionCandidate[];
  readonly omitted: { reason: string; detail?: string }[];
  readonly degraded: string[];
}
export interface DigestPackDependencies {
  readonly formulation: typeof readPublishedProblemFormulation;
  readonly moves: typeof readWorkingMovesPack;
}

// Controls are append-only and lawful redaction removes available content.
// Neither operation necessarily advances public_seq. Compare these private
// witnesses before and after independent readers; never expose their counts.
const DIGEST_WITNESS_SQL = `p.public_seq AS cursor,
  (SELECT COUNT(*) FROM content_controls cc WHERE cc.problem_id = p.id) AS control_count,
  (SELECT COUNT(*) FROM event_content source_content JOIN events source
    ON source.id = source_content.event_id
    WHERE source.problem_id = p.id AND source_content.redacted_at IS NULL
      AND source_content.payload_json IS NOT NULL) AS content_count`;

/** Counts describe visible publication records, never earned dispositions,
 * review weight, actor popularity or negative-result volume. A claim contributes
 * only its latest published version at the captured cut. Source metadata and
 * current controls are checked in SQL; no claim bodies or scientific timelines
 * are transferred merely to count them. The exact statement is verified below. */
const DIGEST_SNAPSHOT_SQL = `WITH visible_records AS (
  SELECT e.object_kind FROM events e
  JOIN event_content c ON c.event_id = e.id
    AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    AND c.payload_json IS NOT NULL
  WHERE e.problem_id = ?1 AND e.seq <= ?2
    AND ((e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
      AND NOT EXISTS (SELECT 1 FROM events newer
        WHERE newer.problem_id = e.problem_id AND newer.object_kind = 'claim'
          AND newer.object_id = e.object_id
          AND newer.type IN ('claim.created', 'claim.revised')
          AND newer.seq > e.seq AND newer.seq <= ?2))
      OR (e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created')
      OR (e.object_kind = 'review' AND e.type = 'review.created'))
    AND NOT ${eventContentHiddenSql("e")}
    AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
)
SELECT ${DIGEST_WITNESS_SQL},
  (SELECT COUNT(*) FROM visible_records WHERE object_kind = 'claim') AS claim_heads,
  (SELECT COUNT(*) FROM visible_records WHERE object_kind = 'hypothesis') AS hypotheses,
  (SELECT COUNT(*) FROM visible_records WHERE object_kind = 'review') AS reviews,
  CASE WHEN EXISTS (SELECT 1 FROM claim_projections cp WHERE cp.problem_id = p.id AND cp.stale = 1)
    OR EXISTS (SELECT 1 FROM projection_health ph WHERE ph.problem_id = p.id AND ph.status = 'drift')
    THEN 1 ELSE 0 END AS stale
FROM problems p WHERE p.id = ?1 AND p.status != 'private-draft'
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;

function validSnapshot(row: DigestSnapshot | null, cursor: number): row is DigestSnapshot {
  return (
    row !== null &&
    row.cursor === cursor &&
    (row.stale === 0 || row.stale === 1) &&
    [row.claim_heads, row.hypotheses, row.reviews, row.control_count, row.content_count].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  );
}

async function statementHash(statement: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(statement));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fable §7.3's compact check-in. It bypasses the generic claims/dispositions,
 * leases and private-handback loaders. Only the canonical move selector can
 * recommend work, and its full permission-checked contract remains a GET away.
 * Partial failures produce null/omission, never a manufactured zero or move. */
export async function readDigestPack(
  input: DigestPackInput,
  dependencies: DigestPackDependencies = {
    formulation: readPublishedProblemFormulation,
    moves: readWorkingMovesPack,
  },
): Promise<DigestPackSection> {
  const omitted: DigestPackSection["omitted"] = [];
  const degraded: string[] = [];
  const fail = (reason: string) => {
    omitted.push({ reason });
    degraded.push(reason);
  };
  const nextUrl = `/v1/p/${input.problemId}/next`;
  // The first witness must finish before either dependent read starts.
  // Starting all three concurrently could miss a visibility change between
  // an early formulation read and a late initial witness.
  const snapshot = await Promise.resolve()
    .then(() =>
      input.db
        .prepare(DIGEST_SNAPSHOT_SQL)
        .bind(input.problemId, input.cursor)
        .first<DigestSnapshot>(),
    )
    .catch(() => null);
  const reads = await Promise.allSettled([
    dependencies.formulation(input.db, input.problemId, input.cursor),
    dependencies.moves({
      ...input,
      // This upper bound grants nothing: the adapter intersects it with the
      // canonical provider's fresh credential/grant/role authorization.
      effectivePermissions: {
        read: true,
        session_open: true,
        workshop_push: true,
        promote: true,
        review: true,
      },
    }),
  ]);
  const [formulationRead, movesRead] = reads;
  let counts: DigestCounts | null = null;
  let projectionHealth = "unavailable";
  if (validSnapshot(snapshot, input.cursor)) {
    const row = snapshot;
    counts = { claim_heads: row.claim_heads, hypotheses: row.hypotheses, reviews: row.reviews };
    projectionHealth = row.stale === 1 ? "STALE" : "no-recorded-drift";
  } else fail("digest_counts_unavailable");
  let statement: { version: number; sha256: string } | null = null;
  const formulation = formulationRead.status === "fulfilled" ? formulationRead.value : undefined;
  if (
    formulation !== undefined &&
    formulation.problem.id === input.problemId &&
    formulation.publication.seq <= input.cursor
  ) {
    statement = {
      version: formulation.problem.current_statement_version,
      sha256: await statementHash(formulation.problem.statement),
    };
  } else fail("problem_formulation_unavailable");
  let nextMove: (Pick<NextMoveCandidate, "move" | "refs"> & { refs_omitted?: number }) | null =
    null;
  let moveStatus = "unavailable";
  if (movesRead.status === "fulfilled") {
    const moves = movesRead.value;
    if (moves.primaryMove !== null) {
      const refs = moves.primaryMove.refs.filter((ref) => ref !== input.problemId);
      nextMove = {
        move: moves.primaryMove.move,
        refs: refs.slice(0, 2),
        ...(refs.length > 2 ? { refs_omitted: refs.length - 2 } : {}),
      };
      moveStatus = moves.degraded ? "partial" : "available";
    } else if (!moves.degraded) moveStatus = "none-permitted";
    if (moves.degraded) fail("digest_moves_incomplete");
    if (moves.omitted.some((item) => item.reason === "moves_permission_filtered"))
      omitted.push({ reason: "moves_permission_filtered" });
  } else fail("digest_moves_unavailable");

  // Counts, formulation and recommendations are independent reads. A newer
  // public write or content control must not be relabelled with the old cut.
  try {
    const head = await input.db
      .prepare(`SELECT ${DIGEST_WITNESS_SQL} FROM problems p
      WHERE p.id = ? AND p.status != 'private-draft'
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`)
      .bind(input.problemId)
      .first<Pick<DigestSnapshot, "cursor" | "control_count" | "content_count">>();
    if (
      !validSnapshot(snapshot, input.cursor) ||
      head?.cursor !== input.cursor ||
      head.control_count !== snapshot.control_count ||
      head.content_count !== snapshot.content_count
    )
      throw new Error("digest cut changed");
  } catch {
    counts = null;
    statement = null;
    nextMove = null;
    projectionHealth = "unavailable";
    moveStatus = "unavailable";
    fail("digest_snapshot_changed");
  }

  return {
    candidates: [
      {
        kind: "standing-context",
        id: "SYS-digest",
        scope: "system",
        untrusted: false,
        tokens: 1,
        stable_prefix: 2,
        body: JSON.stringify({
          statement,
          counts,
          next_move: nextMove,
          move_status: moveStatus,
          projection_health: projectionHealth,
          counts_meaning:
            "Currently readable publication records, not active outcomes or review weight.",
        }),
        why_included: "statement commitment, record counts and canonical next move at this cursor",
      },
    ],
    actions: [
      {
        method: "GET",
        url: nextUrl,
        public_read: false,
        why: "Read the current complete move contract before writing.",
      },
    ],
    omitted: [
      ...omitted,
      {
        reason: "digest_details",
        detail: "Bodies, move contracts and alternatives: read the working pack or next action.",
      },
    ],
    degraded,
  };
}
