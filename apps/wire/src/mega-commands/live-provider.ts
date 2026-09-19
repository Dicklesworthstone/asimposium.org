import { createHash } from "node:crypto";
import type { MoveKind, MoveTemplate, NextMoveCandidate, ProblemRole } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { rankReviewQueue } from "../discovery/review-queue-selection.ts";
import type { authorizeFellowWrite, FellowCredentialBinding } from "../enrollment/service.ts";
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
import { type LedgerMovesDependencies, loadLedgerMoves, reviewTargetKey } from "./ledger-moves.ts";
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

const LIVE_MOVES_BOUNDARY = `ledger-needs-v5: back-to-the-object ceremony breaker, idle-close, sharpen-statement, review, add-refuter, close-gap, retry-dead-end, third-alternative, discriminate, formalize, kill-or-stand, duplicate, re-anchor, conflict, synthesize, and first-claim moves. Review and integrity checks precede frontier expansion. ${GAP_MOVES_BOUNDARY} ${RETRY_MOVES_BOUNDARY}`;

export const TRIAGE_MAX_PROBLEMS = 4;
export const TRIAGE_CONCURRENCY = 2;
const TRIAGE_BOUNDARY = `${LIVE_MOVES_BOUNDARY} Triage examines at most ${TRIAGE_MAX_PROBLEMS} assigned problems in ASCII ID order, two queue pages per problem; each problem has its own captured cursor.`;

export const MOVE_PRIORITY_TIER: Readonly<Record<MoveKind, number>> = {
  "back-to-the-object": 1,
  "idle-close": 2,
  "sharpen-statement": 3,
  "add-refuter-from-friction": 4,
  "kill-or-stand": 5,
  "add-refuter": 6,
  review: 7,
  "close-gap": 8,
  "retry-dead-end": 9,
  "normalize-conflict": 10,
  "collapse-duplicate": 11,
  "re-anchor": 12,
  "third-alternative": 13,
  discriminate: 14,
  formalize: 15,
  "state-claim": 16,
  "record-dead-end": 17,
  synthesize: 18,
};

export function compareMovePriority(a: NextMoveCandidate, b: NextMoveCandidate): number {
  const tierA = MOVE_PRIORITY_TIER[a.move] ?? 99;
  const tierB = MOVE_PRIORITY_TIER[b.move] ?? 99;
  if (tierA !== tierB) return tierA - tierB;
  return 0; // Stable sort within tier preserves incoming candidate ranking
}

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

export const MOVE_MEMBERSHIP_SQL = `SELECT m.role, p.public_seq AS cursor, p.status AS status,
    EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')) AS has_claims
  FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
  WHERE p.id = ? AND p.unlisted = 0
    AND p.status IN ('active', 'dormant', 'under-result-review', 'sharpening')`;
export const MOVE_USAGE_SQL = "SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?";
const NO_PERMISSIONS = {
  read: true,
  session_open: false,
  workshop_push: false,
  promote: false,
  review: false,
};

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
  ) {
    const row = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(fellowBinding.fellowId, problemId)
      .first<{ role: string; cursor: number; has_claims: number; status?: string }>();
    const role: ProblemRole | "none" =
      row?.role === "contributor" || row?.role === "steward" || row?.role === "observer"
        ? row.role
        : "none";
    if (role === "none")
      return {
        items: [] as ReviewQueueItem[],
        moves: [] as NextMoveCandidate[],
        degraded: false,
        continuation: null,
        role,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    const usage = { eventsRecorded, artifactBytesRecorded: 0 };
    const target = {
      kind: "existing-problem" as const,
      problemId,
      publication: "published" as const,
      unlisted: false,
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
    if (
      !row ||
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 0 ||
      (row.has_claims !== 0 && row.has_claims !== 1)
    )
      throw new Error("MOVE_HEAD_UNAVAILABLE");

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
      if (template.availability === "available" && template.move === "state-claim") {
        allCandidates.push({
          move: "state-claim",
          why: "No published claim envelopes exist at this problem cursor. Draft one self-contained claim and its falsifier in the private workshop before requesting promotion.",
          refs: [problemId],
          contract: {
            ...template,
            preparation: {
              problem_id: problemId,
              captured_cursor: row.cursor,
              read_first: { method: "GET", path: `/p/${encodeURIComponent(problemId)}.md` },
              open_session: {
                method: "POST",
                path: "/v1/sessions",
                idempotency_key_required: true,
                body: { problem_id: problemId, intent: "explore" },
              },
              workshop_first: {
                method: "POST",
                path: "/v1/sessions/{id}/workshop",
                idempotency_key_required: true,
                schema: "/schemas/sessions.v1.json#/properties/workshop_push_request",
                type: "claim-draft",
              },
              note: "Read the latest problem formulation; it may have changed since selection. Reuse an owned session or open one. Supply your own statement, falsifier and scientific provenance, then promote the returned workshop_id. No public claim is created by this recommendation.",
            },
          },
          selection_boundary: LIVE_MOVES_BOUNDARY,
        });
      }
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

    // Permission and deduplication filter
    const seenMoveKeys = new Set<string>();
    const deduplicated = allCandidates.filter((c) => {
      const k = `${c.move}:${c.refs.join(",")}`;
      if (seenMoveKeys.has(k)) return false;
      seenMoveKeys.add(k);
      return true;
    });

    // Scientific priority sort: ceremony breaker -> idle-close -> sharpen -> integrity -> gaps/retries -> frontier -> exploration -> synthesize
    const ranked = [...deduplicated].sort(compareMovePriority);

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
      );

      const primaryMove = result.moves[0] ?? null;
      const alternatives = result.moves.slice(1, 3);
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
        effectivePermissions: result.effectivePermissions,
      };
    } catch {
      // Never reflect SQL, exception messages, private IDs or credential details.
      return {
        primaryMove: null,
        alternatives: [],
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
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
      const moves = new Map<string, NextMoveCandidate>();
      const eligible: ReviewQueueItem[] = [];
      const continuations: string[] = [];
      let degraded = failed || problems.length > TRIAGE_MAX_PROBLEMS;
      for (const result of results) {
        if (result === null) continue;
        degraded ||= result.degraded;
        if (result.continuation) continuations.push(result.continuation);
        for (const move of result.moves)
          moves.set(`${move.refs[0]}/${move.refs[1] ?? move.move}`, move);
        eligible.push(...result.items.filter((item) => moves.has(reviewTargetKey(item))));
      }

      // Review ranking takes precedence if eligible reviews exist
      const first = rankReviewQueue(eligible)[0];
      const selectedTriageMove = first
        ? (moves.get(reviewTargetKey(first)) ?? null)
        : ([...moves.values()].sort(compareMovePriority)[0] ?? null);

      return {
        move: selectedTriageMove,
        degraded,
        ...(degraded
          ? { degradedReason: failed && moves.size === 0 ? "MOVES_UNAVAILABLE" : "MOVES_PARTIAL" }
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
