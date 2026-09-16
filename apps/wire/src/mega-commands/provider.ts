import type {
  FellowLifecycleStatus,
  HelloAssignment,
  MoveKind,
  NextMoveCandidate,
  ProblemAdmissionMode,
  ProblemRole,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * Moves that create, mutate, or promote ledger objects.
 * Observers and viewers without promote permission must NEVER be offered these moves (Axiom 6, Rule A2/A9).
 */
export const PROMOTION_MOVE_KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
  "sharpen-statement",
  "state-claim",
  "add-refuter",
  "review",
  "third-alternative",
  "discriminate",
  "kill-or-stand",
  "collapse-duplicate",
  "re-anchor",
  "record-dead-end",
  "synthesize",
  "formalize",
  "add-refuter-from-friction",
  "close-gap",
  "normalize-conflict",
  "retry-dead-end",
  "back-to-the-object",
]);

export interface ProblemMovesRequest {
  readonly problemId: string;
  readonly fellowId: string;
  readonly role: ProblemRole | "none";
  readonly effectivePermissions: Record<string, boolean>;
  readonly db?: D1Database;
}

export interface TriageMovesRequest {
  readonly fellowId: string;
  readonly assignments: readonly HelloAssignment[];
  readonly db?: D1Database;
}

export interface ProblemMovesResult {
  readonly primaryMove: NextMoveCandidate | null;
  readonly alternatives: readonly NextMoveCandidate[];
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly selectionBoundary?: string;
}

export interface TriageMovesResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly selectionBoundary?: string;
}

export interface MegaCommandsMoveProvider {
  nextMoves(request: ProblemMovesRequest): Promise<ProblemMovesResult>;
  triageMove(request: TriageMovesRequest): Promise<TriageMovesResult>;
}

/**
 * Computes effective permissions for a Fellow viewing a problem.
 * Observers never get promote: true.
 * Paused/revoked Fellows get all write/session permissions false.
 */
export function computeViewerPermissions(input: {
  readonly fellowStatus: FellowLifecycleStatus;
  readonly role: ProblemRole | "none";
  readonly admissionMode?: ProblemAdmissionMode;
  readonly problemBinding?: string;
  readonly problemId: string;
}): Record<string, boolean> {
  const { fellowStatus, role, admissionMode = "open", problemBinding, problemId } = input;

  if (fellowStatus !== "active") {
    return {
      read: true,
      session_open: false,
      workshop_push: false,
      promote: false,
      review: false,
    };
  }

  if (problemBinding !== undefined && problemBinding !== problemId) {
    return {
      read: true,
      session_open: false,
      workshop_push: false,
      promote: false,
      review: false,
    };
  }

  const isMember = role !== "none";
  const isObserver = role === "observer";
  const canPromote = isMember && !isObserver;
  const canOpenSession = isMember || admissionMode === "open";

  return {
    read: true,
    session_open: canOpenSession,
    workshop_push: isMember,
    promote: canPromote,
    review: canPromote,
  };
}

/**
 * Deterministic candidate tie-breaker:
 * Sorts by move kind alphabetically, then why, then first ref.
 */
export function compareCandidates(a: NextMoveCandidate, b: NextMoveCandidate): number {
  const moveCmp = a.move.localeCompare(b.move);
  if (moveCmp !== 0) return moveCmp;
  const whyCmp = a.why.localeCompare(b.why);
  if (whyCmp !== 0) return whyCmp;
  const refA = a.refs[0] ?? "";
  const refB = b.refs[0] ?? "";
  return refA.localeCompare(refB);
}

/**
 * Filters move candidates by the viewer's effective permissions.
 * Drops promote moves if promote: false.
 * Drops session-requiring moves if session_open: false.
 * Caps alternatives at 2.
 */
export function filterMovesByPermissions(
  candidates: readonly NextMoveCandidate[],
  effectivePermissions: Record<string, boolean>,
): readonly NextMoveCandidate[] {
  const canPromote = effectivePermissions.promote === true;
  const canOpenSession = effectivePermissions.session_open === true;

  return candidates.filter((candidate) => {
    if (PROMOTION_MOVE_KINDS.has(candidate.move) && !canPromote) {
      return false;
    }
    if (candidate.move === "idle-close" && !canOpenSession) {
      return false;
    }
    return true;
  });
}

/**
 * Truthful production default (bead asimposiumorg-bbx):
 * Before W9.4 is installed, it must never fabricate a highest-value move.
 * Returns degraded: true with explicit reason.
 */
export class TruthfulProductionMovesProvider implements MegaCommandsMoveProvider {
  async nextMoves(_request: ProblemMovesRequest): Promise<ProblemMovesResult> {
    return {
      primaryMove: null,
      alternatives: [],
      degraded: true,
      degradedReason: "W9_MOVES_ENGINE_NOT_INSTALLED",
      selectionBoundary: "w6-envelope-only",
    };
  }

  async triageMove(_request: TriageMovesRequest): Promise<TriageMovesResult> {
    return {
      move: null,
      degraded: true,
      degradedReason: "W9_MOVES_ENGINE_NOT_INSTALLED",
      selectionBoundary: "w6-envelope-only",
    };
  }
}

/**
 * Contract fixture provider for unit/integration testing.
 * Provides pre-configured candidates while strictly enforcing permission filtering.
 */
export class ContractFixtureMovesProvider implements MegaCommandsMoveProvider {
  constructor(
    private readonly fixtures: {
      readonly problemMoves?: Record<string, readonly NextMoveCandidate[]>;
      readonly triageMoves?: Record<string, NextMoveCandidate | null>;
    } = {},
  ) {}

  async nextMoves(request: ProblemMovesRequest): Promise<ProblemMovesResult> {
    const rawCandidates = this.fixtures.problemMoves?.[request.problemId] ?? [];
    const filtered = filterMovesByPermissions(rawCandidates, request.effectivePermissions);
    const sorted = [...filtered].sort(compareCandidates);
    const primaryMove = sorted[0] ?? null;
    const alternatives = sorted.slice(1, 3);

    return {
      primaryMove,
      alternatives,
      degraded: false,
      selectionBoundary: "contract-fixture-provider",
    };
  }

  async triageMove(request: TriageMovesRequest): Promise<TriageMovesResult> {
    const candidate = this.fixtures.triageMoves?.[request.fellowId] ?? null;
    if (candidate === null) {
      return {
        move: null,
        degraded: false,
        selectionBoundary: "contract-fixture-provider",
      };
    }

    // Check candidate against assignments if candidate refs name a problem
    const problemRef = candidate.refs.find((ref) => ref.startsWith("P-"));
    if (problemRef !== undefined) {
      const assignment = request.assignments.find((a) => a.problem_id === problemRef);
      const isObserver = assignment?.role === "observer";
      if (isObserver && PROMOTION_MOVE_KINDS.has(candidate.move)) {
        return {
          move: null,
          degraded: false,
          selectionBoundary: "contract-fixture-provider-permission-filtered",
        };
      }
    }

    return {
      move: candidate,
      degraded: false,
      selectionBoundary: "contract-fixture-provider",
    };
  }
}
