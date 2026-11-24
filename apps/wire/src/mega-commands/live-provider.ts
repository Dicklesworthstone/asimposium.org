import {
  getMoveTemplate,
  type MoveTemplate,
  type NextMoveCandidate,
  type ProblemRole,
} from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { authorizeFellowWrite, FellowCredentialBinding } from "../enrollment/service.ts";
import { sha256Hex } from "../krater/krater.ts";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { type getRemainingBudget, parseSponsorLimit } from "../sessions/quota.ts";
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
import {
  compareMovePriority,
  MOVE_PRIORITY_TIER,
  selectTriageMove,
  uniqueMoves,
} from "./move-selection.ts";
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
export const MOVE_SELECTOR_CONCURRENCY = 2;
const TRIAGE_BOUNDARY = `${LIVE_MOVES_BOUNDARY} Triage examines at most ${TRIAGE_MAX_PROBLEMS} assigned problems in ASCII ID order, two queue pages per problem; each problem has its own captured cursor.`;

type MoveSelection = { moves: NextMoveCandidate[]; degraded: boolean };
type MoveUpdate = (selected: MoveSelection) => MoveSelection | Promise<MoveSelection>;
type MoveRead = { read: () => Promise<MoveUpdate>; fatal?: boolean };

/** Bound independent reads without letting their completion order decide ties,
 * duplicate winners, or which failure takes precedence. Drain all started work
 * before returning, including when a required source failed. */
async function readMoveUpdates(reads: readonly MoveRead[]): Promise<MoveUpdate[]> {
  const results = new Array<PromiseSettledResult<MoveUpdate>>(reads.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MOVE_SELECTOR_CONCURRENCY, reads.length) }, async () => {
      while (next < reads.length) {
        const index = next++;
        const source = reads[index];
        if (source === undefined) throw new Error("MOVE_SELECTOR_UNAVAILABLE");
        try {
          results[index] = { status: "fulfilled", value: await source.read() };
        } catch (reason) {
          results[index] = source.fatal
            ? { status: "rejected", reason }
            : {
                status: "fulfilled",
                value: (selected) => ({ ...selected, degraded: true }),
              };
        }
      }
    }),
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

export interface LiveMovesDependencies extends LedgerMovesDependencies {
  readonly authorize: typeof authorizeFellowWrite;
  readonly readBudget?: typeof getRemainingBudget;
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

export const MOVE_MEMBERSHIP_SQL = `SELECT m.role, p.public_seq AS cursor, p.status AS status,
    p.unlisted, p.admission_mode, p.current_statement_version,
    EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')) AS has_claims
  FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
  WHERE p.id = ? AND p.unlisted IN (0, 1)
    AND p.status IN ('active', 'dormant', 'under-result-review', 'sharpening')
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
export const MOVE_JOINABLE_SQL = `SELECT 1 AS joinable FROM problems
  WHERE id = ?1 AND unlisted = 0
    AND status IN ('active', 'dormant', 'under-result-review', 'sharpening')
    AND (admission_mode IS NULL OR admission_mode = 'open'
      OR (admission_mode IN ('approval-required', 'invite-only')
        AND (sponsor_id = ?2 OR EXISTS (SELECT 1 FROM problem_stewards
          WHERE problem_id = problems.id AND sponsor_id = ?2))))
    AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;
export const MOVE_USAGE_SQL = "SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?";
const NO_PERMISSIONS = {
  read: true,
  session_open: false,
  workshop_push: false,
  promote: false,
  evidence: false,
  dead_end: false,
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

  private async problem(
    db: D1Database,
    problemId: string,
    fellowBinding: FellowCredentialBinding,
    eventsRecorded: number,
    now: number,
    quota: Pick<ProblemMovesRequest, "publicWritesLimited" | "sponsorPromotionRateLimit">,
    capturedCursor?: number,
  ) {
    const row = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(fellowBinding.fellowId, problemId)
      .first<{
        role: string;
        cursor: number;
        has_claims: number;
        current_statement_version: number;
        status?: string;
        unlisted: number;
        admission_mode: string | null;
      }>();
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
      // Match explicit/implicit session admission (0116): open boards admit
      // newcomers, while restricted boards require the owner's or a current
      // steward's sponsorship. Archive admission never grants a new session.
      // Preflight used zero usage; recheck the actual credential grant before
      // advertising autojoin. Every other permission waits for membership.
      const joinable = await db
        .prepare(MOVE_JOINABLE_SQL)
        .bind(problemId, fellowBinding.sponsorId)
        .first<{ joinable: number }>();
      const sessionAllowed =
        joinable?.joinable === 1 &&
        this.dependencies.authorize({
          effect: "session.open",
          credential: fellowBinding,
          target: { kind: "session-admission", problemId },
          usage: { eventsRecorded, artifactBytesRecorded: 0 },
          now,
        }).decision === "allow";
      return {
        items: [] as ReviewQueueItem[],
        moves: [] as NextMoveCandidate[],
        degraded: false,
        continuation: null,
        role,
        effectivePermissions: { ...NO_PERMISSIONS, session_open: sessionAllowed },
      };
    }
    if (
      !row ||
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 0 ||
      !Number.isSafeInteger(row.current_statement_version) ||
      row.current_statement_version < 1 ||
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
    const allowed = (
      effect: "promote" | "review" | "workshop.push",
      action?: "evidence" | "dead-end",
    ) =>
      this.dependencies.authorize({
        effect,
        credential: fellowBinding,
        target: action === undefined ? target : { ...target, action },
        usage,
        now,
      }).decision === "allow";
    // Archival stops fresh sessions and public scientific work. Existing
    // sessions retain private drafting when current membership and grant allow it.
    if (row.admission_mode === "archived-read-only")
      return {
        cursor: row.cursor,
        items: [] as ReviewQueueItem[],
        moves: [] as NextMoveCandidate[],
        degraded: false,
        continuation: null,
        role,
        effectivePermissions: {
          ...NO_PERMISSIONS,
          workshop_push: allowed("workshop.push"),
        },
      };

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
      promote: row.status !== "sharpening" && allowed("promote"),
      evidence: allowed("promote", "evidence"),
      dead_end: allowed("promote", "dead-end"),
      review: allowed("review"),
    };

    // One admission snapshot per problem selection. Retain in-flight and failed
    // reads as well as successful pages: ledger and formalization must observe
    // the same bounded cut, never retry into a different current projection.
    const queuePages = new Map<string, ReturnType<LedgerMovesDependencies["loadQueue"]>>();
    const loadQueue: LedgerMovesDependencies["loadQueue"] = (database, query, snapshot) => {
      const key = JSON.stringify([
        query.problem,
        query.after ?? null,
        snapshot?.problemId ?? null,
        snapshot?.through ?? null,
        snapshot?.includeUnlisted === true,
        snapshot?.excludeOffScope === true,
      ]);
      let page = queuePages.get(key);
      if (page === undefined) {
        page = Promise.resolve().then(() => this.dependencies.loadQueue(database, query, snapshot));
        queuePages.set(key, page);
      }
      return page;
    };
    const {
      backToObject,
      idleClose,
      sharpen,
      deadEnds,
      hypotheses,
      discriminate,
      killOrStand,
      gaps,
      retries,
      conflicts,
      duplicates,
      reanchor,
      formalize,
      synthesize,
    } = this.dependencies;
    const reads: MoveRead[] = [];
    const append = (
      read: () => Promise<{ move: NextMoveCandidate | null; degraded: boolean }>,
      fatal = false,
    ) => {
      reads.push({
        fatal,
        read: async () => {
          const { move, degraded } = await read();
          return (selected) => ({
            moves: move ? [...selected.moves, move] : selected.moves,
            degraded: selected.degraded || degraded,
          });
        },
      });
    };
    let continuation: string | null = null;
    let items: ReviewQueueItem[] = [];

    // 1. Ceremony Breaker (back-to-the-object, §9.6)
    if (backToObject?.load) {
      append(() =>
        backToObject.load(db, problemId, row.cursor, row.status ?? "active", {
          viewer: { fellowId: fellowBinding.fellowId, sponsorId: fellowBinding.sponsorId },
          permissions: effectivePermissions,
          now,
        }),
      );
    }

    // 2. Idle Session Close (idle-close, 3h quiet)
    if (idleClose?.load) append(() => idleClose.load(db, problemId, fellowBinding.fellowId, now));

    // 3. Statement Sharpening (sharpen-statement)
    if (
      sharpen?.load &&
      effectivePermissions.session_open &&
      (effectivePermissions.review || effectivePermissions.workshop_push)
    ) {
      append(() =>
        sharpen.load(db, problemId, row.cursor, {
          fellowId: fellowBinding.fellowId,
          sponsorId: fellowBinding.sponsorId,
          review: effectivePermissions.review,
          workshopPush: effectivePermissions.workshop_push,
        }),
      );
    }

    // 4. Ledger Moves (reviews and refuters)
    if (
      row.status !== "sharpening" &&
      row.has_claims === 0 &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      append(
        async () => ({
          move: firstClaimMove(
            problemId,
            row.cursor,
            row.current_statement_version,
            this.dependencies.firstClaimTemplate(),
            LIVE_MOVES_BOUNDARY,
          ),
          degraded: false,
        }),
        true,
      );
    } else if (row.has_claims > 0) {
      if (deadEnds?.load) append(() => deadEnds.load(db, problemId, row.cursor));
      reads.push({
        // Preserve the existing required-ledger failure policy. Independent
        // gap/retry sources can keep a partially available selection useful.
        fatal: !gaps && !retries,
        read: async () => {
          const result = await loadLedgerMoves(
            db,
            problemId,
            fellowBinding,
            effectivePermissions,
            { ...this.dependencies, loadQueue },
            row.cursor,
            { includeUnlisted: row.unlisted === 1 },
          );
          return async (selected) => {
            items = result.items;
            continuation = result.continuation;
            // Friction depends on these queue targets and transforms earlier
            // refuter candidates, so apply it in the original reduction order.
            return withFrictionMove(
              db,
              problemId,
              row.cursor,
              items,
              effectivePermissions,
              {
                moves: [...selected.moves, ...result.moves],
                degraded: selected.degraded || result.degraded,
              },
              this.dependencies.frictions,
            );
          };
        },
      });
    }

    // 5. Hypotheses (third-alternative, discriminate, kill-or-stand)
    if (hypotheses?.load && effectivePermissions.session_open && effectivePermissions.promote) {
      reads.push({
        read: async () => {
          const extra = selectThirdAlternative(
            problemId,
            row.cursor,
            await hypotheses.load(db, problemId, row.cursor),
            hypotheses.template,
          );
          return (selected) => ({
            moves:
              extra.move === null
                ? selected.moves
                : [
                    ...selected.moves.filter((move) => move.move !== "state-claim"),
                    extra.move,
                    ...selected.moves.filter((move) => move.move === "state-claim"),
                  ],
            degraded: selected.degraded || extra.degraded,
          });
        },
      });
    }

    if (discriminate?.load && effectivePermissions.session_open && effectivePermissions.evidence)
      append(() => discriminate.load(db, problemId, row.cursor));

    if (killOrStand?.load && effectivePermissions.session_open && effectivePermissions.promote)
      append(() => killOrStand.load(db, problemId, row.cursor));

    // 6. Gaps (close-gap)
    if (
      row.has_claims > 0 &&
      gaps?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    ) {
      reads.push({
        read: async () => {
          const extra = await gaps.load(db, problemId, row.cursor, now);
          return (selected) =>
            withGapMove(db, problemId, row.cursor, now, effectivePermissions, selected, {
              load: async () => extra,
            });
        },
      });
    }

    // 7. Retries (retry-dead-end)
    if (
      retries?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.dead_end &&
      effectivePermissions.workshop_push
    ) {
      reads.push({
        read: async () => {
          const extra = await retries.load(db, problemId, row.cursor, fellowBinding.fellowId);
          return (selected) =>
            withRetryMove(
              db,
              problemId,
              row.cursor,
              fellowBinding.fellowId,
              effectivePermissions,
              selected,
              {
                load: async () => extra,
              },
            );
        },
      });
    }

    // 8. Conflicts (normalize-conflict)
    if (
      row.has_claims > 0 &&
      conflicts?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    )
      append(() => conflicts.load(db, problemId, row.cursor));

    // 9. Duplicates (collapse-duplicate)
    if (
      row.has_claims > 0 &&
      duplicates?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    )
      append(() => duplicates.load(db, problemId, row.cursor));

    // 10. Re-anchor (re-anchor)
    if (
      row.has_claims > 0 &&
      reanchor?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.promote
    )
      append(() => reanchor.load(db, problemId, fellowBinding.fellowId, row.cursor));

    // 11. Formalize (formalize)
    if (
      row.has_claims > 0 &&
      formalize?.load &&
      effectivePermissions.session_open &&
      effectivePermissions.evidence
    ) {
      append(() =>
        formalize.load(
          db,
          problemId,
          row.cursor,
          {
            load: (database, problem, through, after) =>
              loadQueue(
                database,
                { problem, ...(after === undefined ? {} : { after }) },
                {
                  problemId: problem,
                  through,
                  ...(row.unlisted === 1 ? { includeUnlisted: true } : {}),
                },
              ),
            template: () => getMoveTemplate("formalize"),
          },
          { includeUnlisted: row.unlisted === 1 },
        ),
      );
    }

    // 12. Synthesize (synthesize)
    if (synthesize?.load && effectivePermissions.session_open && effectivePermissions.promote)
      append(() => synthesize.load(db, problemId, row.cursor));

    let selected: MoveSelection = { moves: [], degraded: false };
    for (const update of await readMoveUpdates(reads)) selected = await update(selected);
    const { moves: allCandidates } = selected;
    let degraded = selected.degraded;
    let limited = quota.publicWritesLimited;
    // Working packs already observed this problem's quota. For next and triage,
    // evaluate each admitted board separately before ranking its candidates.
    if (limited === undefined && this.dependencies.readBudget && allCandidates.length > 0) {
      try {
        const budget = await this.dependencies.readBudget(db, {
          problemId,
          fellowId: fellowBinding.fellowId,
          sponsorId: fellowBinding.sponsorId,
          sponsorLimit: parseSponsorLimit(quota.sponsorPromotionRateLimit),
          now,
        });
        limited = budget.remaining === 0 || budget.sponsor_remaining === 0;
      } catch {
        limited = true;
        degraded = true;
      }
    }

    // Permission checks precede deduplication; different needs sharing a
    // target retain their own contracts until the common priority selection.
    const deduplicated = uniqueMoves(
      filterMovesByPermissions(allCandidates, effectivePermissions, limited),
    );

    // Scientific priority sort: ceremony breaker -> idle-close -> sharpen -> integrity -> gaps/retries -> frontier -> exploration -> synthesize
    const ranked = [...deduplicated].sort(compareMovePriority);

    // Every selected problem captures a cut, including ordinary next and
    // triage requests. Recheck membership and present-day visibility after
    // the independent selectors; an explicit caller cursor is not required.
    const current = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(fellowBinding.fellowId, problemId)
      .first<{
        role: string;
        cursor: number;
        has_claims: number;
        current_statement_version: number;
        status?: string;
        unlisted: number;
        admission_mode: string | null;
      }>();
    if (!current) throw new MoveSnapshotError("MOVES_SCOPE_UNAVAILABLE");
    if (
      current.cursor !== row.cursor ||
      current.role !== row.role ||
      current.status !== row.status ||
      current.unlisted !== row.unlisted ||
      current.admission_mode !== row.admission_mode ||
      current.current_statement_version !== row.current_statement_version ||
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
        request,
        request.capturedCursor,
      );

      const permittedMoves = result.moves;
      const primaryMove = permittedMoves[0] ?? null;
      const alternatives = permittedMoves.slice(1, 3);
      const latencyMs = Date.now() - startTime;

      const publicDigest = await sha256Hex(`${problemId}:${result.moves.length}`);

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
        viewerRole: result.role,
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
              results[position] = await this.problem(
                db,
                id,
                fellowBinding,
                eventsRecorded,
                now,
                request,
              );
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
