import { createHash } from "node:crypto";
import type { MoveTemplate, NextMoveCandidate, ProblemRole } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { authorizeFellowWrite, FellowCredentialBinding } from "../enrollment/service.ts";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import type { selectBackToObjectMove } from "./back-to-object-moves.ts";
import type { selectNormalizeConflictMove } from "./conflict-moves.ts";
import type { selectRecordDeadEndMove } from "./dead-end-moves.ts";
import type { selectDiscriminateMove } from "./discriminate-moves.ts";
import type { selectCollapseDuplicateMove } from "./duplicate-moves.ts";
import type { selectFormalizeMove } from "./formalize-moves.ts";
import { type FrictionMoveSource, withFrictionMove } from "./friction-moves.ts";
import { GAP_MOVES_BOUNDARY, type GapMoveSource, withGapMove } from "./gap-moves.ts";
import { type HypothesisMoveSource, selectThirdAlternative } from "./hypothesis-moves.ts";
import type { selectIdleCloseMove } from "./idle-close-moves.ts";
import type { selectKillOrStandMove } from "./kill-moves.ts";
import { firstClaimMove, type LedgerMovesDependencies, loadLedgerMoves } from "./ledger-moves.ts";
import { filterMovesByPermissions } from "./move-permissions.ts";
import { compareMovePriority, MOVE_PRIORITY_TIER, selectTriageMove, uniqueMoves } from "./move-selection.ts";
import type {
  MegaCommandsMoveProvider,
  ProblemMovesRequest,
  ProblemMovesResult,
  TriageMovesRequest,
  TriageMovesResult,
} from "./provider.ts";
import type { selectReanchorMove } from "./reanchor-moves.ts";
import { RETRY_MOVES_BOUNDARY, type RetryMoveSource, withRetryMove } from "./retry-moves.ts";
import type { selectSharpenStatementMove } from "./sharpen-moves.ts";
import type { selectSynthesizeMove } from "./synthesize-moves.ts";

export { compareMovePriority, MOVE_PRIORITY_TIER } from "./move-selection.ts";

const LIVE_MOVES_BOUNDARY = `ledger-needs-v5: back-to-the-object ceremony breaker, idle-close, sharpen-statement, review, add-refuter, close-gap, retry-dead-end, third-alternative, discriminate, formalize, kill-or-stand, duplicate, re-anchor, conflict, synthesize, and first-claim moves. Review and integrity checks precede frontier expansion. Known unlisted memberships stay scoped; remaining unlisted queue admissions have no public discovery continuation. ${GAP_MOVES_BOUNDARY} ${RETRY_MOVES_BOUNDARY}`;

export const TRIAGE_MAX_PROBLEMS = 4;
export const TRIAGE_CONCURRENCY = 2;
const TRIAGE_BOUNDARY = `${LIVE_MOVES_BOUNDARY} Triage examines at most ${TRIAGE_MAX_PROBLEMS} assigned problems in ASCII ID order, two queue pages per problem; each problem has its own captured cursor.`;

export interface LiveMovesDependencies extends LedgerMovesDependencies {
  readonly authorize: typeof authorizeFellowWrite;
  readonly now: () => number;
  readonly firstClaimTemplate: () => MoveTemplate;
  readonly hypotheses?: HypothesisMoveSource;
  readonly gaps?: GapMoveSource;
  readonly retries?: RetryMoveSource;
  readonly frictions?: FrictionMoveSource;
  readonly discriminate?: { load: typeof selectDiscriminateMove };
  readonly killOrStand?: { load: typeof selectKillOrStandMove };
  readonly formalize?: { load: typeof selectFormalizeMove };
  readonly sharpen?: { load: typeof selectSharpenStatementMove };
  readonly duplicates?: { load: typeof selectCollapseDuplicateMove };
  readonly reanchor?: { load: typeof selectReanchorMove };
  readonly conflicts?: { load: typeof selectNormalizeConflictMove };
  readonly synthesize?: { load: typeof selectSynthesizeMove };
  readonly backToObject?: { load: typeof selectBackToObjectMove };
  readonly idleClose?: { load: typeof selectIdleCloseMove };
  readonly deadEnds?: { load: typeof selectRecordDeadEndMove };
}

export const MOVE_MEMBERSHIP_SQL = `SELECT m.role, p.public_seq AS cursor, p.status AS status, p.unlisted,
    EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')) AS has_claims
  FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
  WHERE p.id = ? AND p.unlisted IN (0, 1)
    AND p.status IN ('active', 'dormant', 'under-result-review', 'sharpening')
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
export const MOVE_JOINABLE_SQL = `SELECT 1 AS joinable FROM problems
  WHERE id = ? AND unlisted = 0
    AND status IN ('active', 'dormant', 'under-result-review', 'sharpening')
    AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;
export const MOVE_USAGE_SQL = "SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?";
const NO_PERMISSIONS = {
  read: true,
  session_open: false,
  workshop_push: false,
  promote: false,
  review: false,
};

class MoveSnapshotError extends Error {
  constructor(
    readonly code: "MOVES_CURSOR_CHANGED" | "MOVES_CURSOR_INVALID" | "MOVES_SCOPE_UNAVAILABLE",
  ) {
    super(code);
  }
}

function logMovesDiagnostic(diagnostic: {
  problem_id: string;
  cursor: number;
  candidate_move_ids: string[];
  selected_move_ids: string[];
  public_input_digest: string;
  score_components: Record<string, unknown>;
  latency_ms: number;
  diff: Record<string, unknown>;
}) {
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "mega-commands-moves-evaluated",
      problem_id: diagnostic.problem_id,
      projection: "moves-v1",
      cursor: diagnostic.cursor,
      candidate_move_ids: diagnostic.candidate_move_ids,
      selected_move_ids: diagnostic.selected_move_ids,
      public_input_digest: diagnostic.public_input_digest,
      score_components: diagnostic.score_components,
      excluded_signal_assertions: {
        activity_volume_excluded: true,
        model_brand_excluded: true,
        actor_volume_excluded: true,
        token_accounting_excluded: true,
      },
      latency_ms: diagnostic.latency_ms,
      diff: diagnostic.diff,
    }),
  );
}

export class LedgerMovesProvider implements MegaCommandsMoveProvider {
  private readonly dependencies: LiveMovesDependencies;
  constructor(dependencies: LiveMovesDependencies) {
    this.dependencies = dependencies;
  }

  private preflight(
    fellowBinding: FellowCredentialBinding,
    problemId: string,
    now: number,
  ): boolean {
    return (
      this.dependencies.authorize({
        effect: "session.open",
        credential: fellowBinding,
        target: { kind: "session-admission", problemId },
        usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
        now,
      }).decision === "allow"
    );
  }

  private async usage(db: D1Database, fellowBinding: FellowCredentialBinding): Promise<number> {
    if (fellowBinding.grantedResources.eventBudget === undefined) return 0;
    const row = await db
      .prepare(MOVE_USAGE_SQL)
      .bind(fellowBinding.credentialId)
      .first<{ count: number }>();
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
      throw new Error("MOVE_USAGE_UNAVAILABLE");
    return row.count;
  }

  private async withHypotheses(
    db: D1Database,
    problemId: string,
    cursor: number,
    permissions: Record<string, boolean>,
    selected: { moves: NextMoveCandidate[]; degraded: boolean },
  ): Promise<{ moves: NextMoveCandidate[]; degraded: boolean }> {
    const source = this.dependencies.hypotheses;
    if (!source || !permissions.session_open || !permissions.promote) return selected;
    try {
      const extra = selectThirdAlternative(
        problemId,
        cursor,
        await source.load(db, problemId, cursor),
        source.template,
      );
      return {
        moves:
          extra.move === null
            ? selected.moves
            : [
                ...selected.moves.filter((move) => move.move !== "state-claim"),
                extra.move,
                ...selected.moves.filter((move) => move.move === "state-claim"),
              ],
        degraded: selected.degraded || extra.degraded,
      };
    } catch {
      return { moves: selected.moves, degraded: true };
    }
  }

  private async problem(
    db: D1Database,
    problemId: string,
    fellowBinding: FellowCredentialBinding,
    eventsRecorded: number,
    now: number,
    capturedCursor?: number,
  ) {
    const row = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(fellowBinding.fellowId, problemId)
      .first<{ role: string; cursor: number; has_claims: number; status?: string; unlisted: number }>();
    const role: ProblemRole | "none" =
      row?.role === "contributor" || row?.role === "steward" || row?.role === "observer"
        ? row.role
        : "none";
    if (capturedCursor !== undefined) {
      // Existing selectors include current projections and coordination state.
      // They cannot promise a historical reconstruction after the public head
      // has advanced. Refuse the entire selection instead of relabelling it.
      if (!row || role === "none") throw new MoveSnapshotError("MOVES_SCOPE_UNAVAILABLE");
      if (row.cursor !== capturedCursor) throw new MoveSnapshotError("MOVES_CURSOR_CHANGED");
    }
    if (role === "none") {
      // Opening a session is how a Fellow joins (§6.8), and session admission
      // already passed preflight. A listed problem in a working status is
      // therefore joinable; every other permission waits for membership.
      const joinable = await db
        .prepare(MOVE_JOINABLE_SQL)
        .bind(problemId)
        .first<{ joinable: number }>();
      return {
        items: [] as ReviewQueueItem[],
        moves: [] as NextMoveCandidate[],
        degraded: false,
        continuation: null,
        role,
        effectivePermissions: { ...NO_PERMISSIONS, session_open: joinable?.joinable === 1 },
      };
    }
    if (
      !row ||
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 0 ||
      (row.unlisted !== 0 && row.unlisted !== 1) ||
      (row.has_claims !== 0 && row.has_claims !== 1)
    )
      throw new Error("MOVE_HEAD_UNAVAILABLE");

    const usage = { eventsRecorded, artifactBytesRecorded: 0 };
    const target = {
      kind: "existing-problem" as const,
      problemId,
      publication: "published" as const,
      unlisted: row.unlisted === 1,
      membershipRole: role,
    };
    const allowed = (effect: "promote" | "review" | "workshop.push") =>
      this.dependencies.authorize({ effect, credential: fellowBinding, target, usage, now })
        .decision === "allow";
    const effectivePermissions = {
      read: true,
      session_open:
        this.dependencies.authorize({
          effect: "session.open",
          credential: fellowBinding,
          target: { kind: "session-admission", problemId },
          usage,
          now,
        }).decision === "allow",
      workshop_push: allowed("workshop.push"),
      promote: allowed("promote"),
      review: allowed("review"),
    };

    const allCandidates: NextMoveCandidate[] = [];
    let degraded = false;
    let continuation: string | null = null;
    let items: ReviewQueueItem[] = [];

    // 1. Ceremony Breaker (back-to-the-object, §9.6)
    if (this.dependencies.backToObject?.load) {
      try {
        const b = await this.dependencies.backToObject.load(
          db,
          problemId,
          row.cursor,
          row.status ?? "active",
        );
        if (b.move) allCandidates.push(b.move);
        degraded ||= b.degraded;
      } catch {
        degraded = true;
      }
    }

    // 2. Idle Session Close (idle-close, 3h quiet)
    if (this.dependencies.idleClose?.load) {
      try {
        const ic = await this.dependencies.idleClose.load(
          db,
          problemId,
          fellowBinding.fellowId,
          now,
        );
        if (ic.move) allCandidates.push(ic.move);
        degraded ||= ic.degraded;
      } catch {
        degraded = true;
      }
    }

    // 3. Statement Sharpening (sharpen-statement)
    if (
      this.dependencies.sharpen?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const sm = await this.dependencies.sharpen.load(db, problemId, row.cursor);
        if (sm.move) allCandidates.push(sm.move);
        degraded ||= sm.degraded;
      } catch {
        degraded = true;
      }
    }

    // 4. Ledger Moves (reviews and refuters)
    if (row.has_claims === 0 && effectivePermissions.session_open && effectivePermissions.promote) {
      const template = this.dependencies.firstClaimTemplate();
      const first = firstClaimMove(problemId, row.cursor, template, LIVE_MOVES_BOUNDARY);
      if (first) allCandidates.push(first);
    } else if (row.has_claims > 0) {
      if (this.dependencies.deadEnds?.load) {
        try {
          const de = await this.dependencies.deadEnds.load(db, problemId, row.cursor);
          if (de.move) allCandidates.push(de.move);
          degraded ||= de.degraded;
        } catch {
          degraded = true;
        }
      }
      try {
        const result = await loadLedgerMoves(
          db,
          problemId,
          fellowBinding,
          effectivePermissions,
          this.dependencies,
          row.cursor,
          { includeUnlisted: row.unlisted === 1 },
        );
        items = result.items;
        continuation = result.continuation;
        degraded ||= result.degraded;
        allCandidates.push(...result.moves);

        // Formalization friction refuters
        if (this.dependencies.frictions?.load && items.length > 0) {
          const frictionResult = await withFrictionMove(
            db,
            problemId,
            row.cursor,
            items,
            effectivePermissions,
            { moves: [...allCandidates], degraded },
            this.dependencies.frictions,
          );
          allCandidates.length = 0;
          allCandidates.push(...frictionResult.moves);
          degraded ||= frictionResult.degraded;
        }
      } catch (error) {
        if (!this.dependencies.gaps && !this.dependencies.retries) throw error;
        degraded = true;
      }
    }

    // 5. Hypotheses (third-alternative, discriminate, kill-or-stand)
    if (this.dependencies.hypotheses?.load && effectivePermissions.session_open) {
      const hypSelected = await this.withHypotheses(
        db,
        problemId,
        row.cursor,
        effectivePermissions,
        { moves: [...allCandidates], degraded },
      );
      allCandidates.length = 0;
      allCandidates.push(...hypSelected.moves);
      degraded ||= hypSelected.degraded;
    }

    if (
      this.dependencies.discriminate?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const dm = await this.dependencies.discriminate.load(db, problemId, row.cursor);
        if (dm.move) allCandidates.push(dm.move);
        degraded ||= dm.degraded;
      } catch {
        degraded = true;
      }
    }

    if (
      this.dependencies.killOrStand?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const km = await this.dependencies.killOrStand.load(db, problemId, row.cursor);
        if (km.move) allCandidates.push(km.move);
        degraded ||= km.degraded;
      } catch {
        degraded = true;
      }
    }

    // 6. Gaps (close-gap)
    if (row.has_claims > 0 && this.dependencies.gaps?.load) {
      const gapSelected = await withGapMove(
        db,
        problemId,
        row.cursor,
        now,
        effectivePermissions,
        { moves: [...allCandidates], degraded },
        this.dependencies.gaps,
      );
      allCandidates.length = 0;
      allCandidates.push(...gapSelected.moves);
      degraded ||= gapSelected.degraded;
    }

    // 7. Retries (retry-dead-end)
    if (this.dependencies.retries?.load) {
      const retrySelected = await withRetryMove(
        db,
        problemId,
        row.cursor,
        fellowBinding.fellowId,
        effectivePermissions,
        { moves: [...allCandidates], degraded },
        this.dependencies.retries,
      );
      allCandidates.length = 0;
      allCandidates.push(...retrySelected.moves);
      degraded ||= retrySelected.degraded;
    }

    // 8. Conflicts (normalize-conflict)
    if (
      row.has_claims > 0 &&
      this.dependencies.conflicts?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const cm = await this.dependencies.conflicts.load(db, problemId, row.cursor);
        if (cm.move) allCandidates.push(cm.move);
        degraded ||= cm.degraded;
      } catch {
        degraded = true;
      }
    }

    // 9. Duplicates (collapse-duplicate)
    if (
      row.has_claims > 0 &&
      this.dependencies.duplicates?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const dup = await this.dependencies.duplicates.load(db, problemId, row.cursor);
        if (dup.move) allCandidates.push(dup.move);
        degraded ||= dup.degraded;
      } catch {
        degraded = true;
      }
    }

    // 10. Re-anchor (re-anchor)
    if (
      row.has_claims > 0 &&
      this.dependencies.reanchor?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const ra = await this.dependencies.reanchor.load(
          db,
          problemId,
          fellowBinding.fellowId,
          row.cursor,
        );
        if (ra.move) allCandidates.push(ra.move);
        degraded ||= ra.degraded;
      } catch {
        degraded = true;
      }
    }

    // 11. Formalize (formalize)
    if (
      row.has_claims > 0 &&
      this.dependencies.formalize?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const fm = await this.dependencies.formalize.load(db, problemId, row.cursor);
        if (fm.move) allCandidates.push(fm.move);
        degraded ||= fm.degraded;
      } catch {
        degraded = true;
      }
    }

    // 12. Synthesize (synthesize)
    if (
      this.dependencies.synthesize?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      try {
        const syn = await this.dependencies.synthesize.load(db, problemId, row.cursor);
        if (syn.move) allCandidates.push(syn.move);
        degraded ||= syn.degraded;
      } catch {
        degraded = true;
      }
    }

    // Permission checks precede deduplication; different needs sharing a
    // target retain their own contracts until the common priority selection.
    const deduplicated = uniqueMoves(filterMovesByPermissions(allCandidates, effectivePermissions));

    // Scientific priority sort: ceremony breaker -> idle-close -> sharpen -> integrity -> gaps/retries -> frontier -> exploration -> synthesize
    const ranked = [...deduplicated].sort(compareMovePriority);

    // Every selected problem captures a cut, including ordinary next and
    // triage requests. Recheck membership and present-day visibility after
    // the independent selectors; an explicit caller cursor is not required.
    const current = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(fellowBinding.fellowId, problemId)
      .first<{ role: string; cursor: number; has_claims: number; status?: string; unlisted: number }>();
    if (!current) throw new MoveSnapshotError("MOVES_SCOPE_UNAVAILABLE");
    if (
      current.cursor !== row.cursor ||
      current.role !== row.role ||
      current.status !== row.status ||
      current.unlisted !== row.unlisted ||
      current.has_claims !== row.has_claims
    )
      throw new MoveSnapshotError("MOVES_CURSOR_CHANGED");

    return {
      cursor: row.cursor,
      items,
      moves: ranked,
      degraded,
      continuation,
      role,
      effectivePermissions,
    };
  }

  async nextMoves(request: ProblemMovesRequest): Promise<ProblemMovesResult> {
    const startTime = Date.now();
    const { db, credential: fellowBinding, problemId } = request;
    if (!db || !fellowBinding || fellowBinding.fellowId !== request.fellowId)
      return {
        primaryMove: null,
        alternatives: [],
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: LIVE_MOVES_BOUNDARY,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    try {
      if (
        request.capturedCursor !== undefined &&
        (!Number.isSafeInteger(request.capturedCursor) || request.capturedCursor < 0)
      )
        throw new MoveSnapshotError("MOVES_CURSOR_INVALID");
      const now = this.dependencies.now();
      if (!this.preflight(fellowBinding, problemId, now))
        return {
          primaryMove: null,
          alternatives: [],
          degraded: false,
          selectionBoundary: LIVE_MOVES_BOUNDARY,
          effectivePermissions: { ...NO_PERMISSIONS },
        };
      const result = await this.problem(
        db,
        problemId,
        fellowBinding,
        await this.usage(db, fellowBinding),
        now,
        request.capturedCursor,
      );

      const permittedMoves = filterMovesByPermissions(
        result.moves,
        result.effectivePermissions,
        request.publicWritesLimited,
      );
      const primaryMove = permittedMoves[0] ?? null;
      const alternatives = permittedMoves.slice(1, 3);
      const latencyMs = Date.now() - startTime;

      const publicDigest = createHash("sha256")
        .update(`${problemId}:${result.moves.length}`)
        .digest("hex");

      logMovesDiagnostic({
        problem_id: problemId,
        cursor: result.cursor ?? 0,
        candidate_move_ids: result.moves.map((m) => `${m.move}:${m.refs.join(",")}`),
        selected_move_ids: primaryMove
          ? [
              `${primaryMove.move}:${primaryMove.refs.join(",")}`,
              ...alternatives.map((a) => `${a.move}:${a.refs.join(",")}`),
            ]
          : [],
        public_input_digest: publicDigest,
        score_components: {
          candidates_count: result.moves.length,
          primary_tier: primaryMove ? (MOVE_PRIORITY_TIER[primaryMove.move] ?? 99) : null,
          degraded: result.degraded,
        },
        latency_ms: latencyMs,
        diff: {
          primary_move: primaryMove?.move ?? null,
          alternatives_count: alternatives.length,
        },
      });

      return {
        primaryMove,
        alternatives,
        degraded: result.degraded,
        ...(result.degraded ? { degradedReason: "MOVES_PARTIAL" } : {}),
        selectionBoundary: `${LIVE_MOVES_BOUNDARY}${result.continuation ? ` Continue discovery: ${result.continuation}` : ""}`,
        ...(result.cursor === undefined ? {} : { capturedCursor: result.cursor }),
        effectivePermissions: result.effectivePermissions,
      };
    } catch (error) {
      // Never reflect SQL, exception messages, private IDs or credential details.
      return {
        primaryMove: null,
        alternatives: [],
        degraded: true,
        degradedReason: error instanceof MoveSnapshotError ? error.code : "MOVES_UNAVAILABLE",
        selectionBoundary: LIVE_MOVES_BOUNDARY,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    }
  }

  async triageMove(request: TriageMovesRequest): Promise<TriageMovesResult> {
    const { db, credential: fellowBinding } = request;
    if (!db || !fellowBinding || fellowBinding.fellowId !== request.fellowId)
      return {
        move: null,
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: TRIAGE_BOUNDARY,
      };
    try {
      const now = this.dependencies.now();
      const problems = [...new Set(request.assignments.map((assignment) => assignment.problem_id))]
        .filter((id) => this.preflight(fellowBinding, id, now))
        .sort();
      if (problems.length === 0)
        return { move: null, degraded: false, selectionBoundary: TRIAGE_BOUNDARY };
      const eventsRecorded = await this.usage(db, fellowBinding);
      const selected = problems.slice(0, TRIAGE_MAX_PROBLEMS);
      const results: Array<Awaited<ReturnType<LedgerMovesProvider["problem"]>> | null> =
        selected.map(() => null);
      let index = 0;
      let failed = false;
      await Promise.all(
        Array.from({ length: Math.min(TRIAGE_CONCURRENCY, selected.length) }, async () => {
          while (index < selected.length) {
            const position = index++;
            const id = selected[position];
            if (id === undefined) break;
            try {
              results[position] = await this.problem(db, id, fellowBinding, eventsRecorded, now);
            } catch {
              failed = true;
            }
          }
        }),
      );
      const moves: NextMoveCandidate[] = [];
      const items: ReviewQueueItem[] = [];
      const continuations: string[] = [];
      let degraded = failed || problems.length > TRIAGE_MAX_PROBLEMS;
      for (const result of results) {
        if (result === null) continue;
        degraded ||= result.degraded;
        if (result.continuation) continuations.push(result.continuation);
        moves.push(...result.moves);
        items.push(...result.items);
      }

      const selectedTriageMove = selectTriageMove(moves, items);

      return {
        move: selectedTriageMove,
        degraded,
        ...(degraded
          ? { degradedReason: failed && moves.length === 0 ? "MOVES_UNAVAILABLE" : "MOVES_PARTIAL" }
          : {}),
        selectionBoundary: `${TRIAGE_BOUNDARY}${continuations.length ? ` Continue discovery: ${continuations.join(" ; ")}` : ""}`,
      };
    } catch {
      return {
        move: null,
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: TRIAGE_BOUNDARY,
      };
    }
  }
}
