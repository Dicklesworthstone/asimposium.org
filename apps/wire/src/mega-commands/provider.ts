import {
  type FellowLifecycleStatus,
  getMoveTemplate,
  type HelloAssignment,
  type MoveKind,
  type NextMoveCandidate,
  type ProblemAdmissionMode,
  type ProblemRole,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadReviewQueue } from "../discovery/review-queue-service.ts";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { loadLiveHypotheses } from "../ledger/hypotheses-service.ts";
import { LedgerMovesProvider } from "./live-provider.ts";

/** Moves needing promotion permission. Reviews have their own scope and are
 * permitted for observers by centralized Fellow authorization (Fable §9.3). */
export const PROMOTION_MOVE_KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
  "sharpen-statement",
  "state-claim",
  "add-refuter",
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
  /** Server-authenticated binding, never request JSON. */
  readonly credential?: FellowCredentialBinding;
}

export interface TriageMovesRequest {
  readonly fellowId: string;
  readonly assignments: readonly HelloAssignment[];
  readonly db?: D1Database;
  readonly credential?: FellowCredentialBinding;
}

export interface ProblemMovesResult {
  readonly primaryMove: NextMoveCandidate | null;
  readonly alternatives: readonly NextMoveCandidate[];
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly selectionBoundary?: string;
  /** Production's current central-policy snapshot replaces coarse UI hints. */
  readonly effectivePermissions?: Record<string, boolean>;
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

/** Coarse role hints for test providers. Production rechecks centralized
 * authorization with the authenticated grant, current membership and usage. */
export function computeViewerPermissions(input: {
  readonly fellowStatus: FellowLifecycleStatus;
  readonly role: ProblemRole | "none";
  readonly admissionMode?: ProblemAdmissionMode;
  readonly problemBinding?: string;
  readonly problemId: string;
}): Record<string, boolean> {
  const { fellowStatus, role, admissionMode = "open", problemBinding, problemId } = input;
  if (fellowStatus !== "active" || (problemBinding !== undefined && problemBinding !== problemId)) {
    return { read: true, session_open: false, workshop_push: false, promote: false, review: false };
  }
  const isMember = role !== "none";
  return {
    read: true,
    session_open: isMember || admissionMode === "open",
    workshop_push: isMember,
    promote: isMember && role !== "observer",
    review: isMember,
  };
}

/** Deterministic ordering for contract fixtures only; production ranks the
 * canonical scientific needs, not the alphabetical spelling of move kinds. */
export function compareCandidates(a: NextMoveCandidate, b: NextMoveCandidate): number {
  const moveCmp = a.move.localeCompare(b.move);
  if (moveCmp !== 0) return moveCmp;
  const whyCmp = a.why.localeCompare(b.why);
  if (whyCmp !== 0) return whyCmp;
  return (a.refs[0] ?? "").localeCompare(b.refs[0] ?? "");
}

export function filterMovesByPermissions(
  candidates: readonly NextMoveCandidate[],
  effectivePermissions: Record<string, boolean>,
): readonly NextMoveCandidate[] {
  return candidates.filter((candidate) => {
    if (PROMOTION_MOVE_KINDS.has(candidate.move) && effectivePermissions.promote !== true)
      return false;
    if (candidate.move === "review" && effectivePermissions.review !== true) return false;
    if (effectivePermissions.session_open !== true) return false;
    return true;
  });
}

/** Real, bounded production selection. No fixture provider or alternate
 * scientific evaluator is reachable from request data. */
export class TruthfulProductionMovesProvider extends LedgerMovesProvider {
  constructor() {
    super({
      loadQueue: loadReviewQueue,
      templateFor: getMoveTemplate,
      authorize: authorizeFellowWrite,
      now: () => Date.now(),
      firstClaimTemplate: () => getMoveTemplate("state-claim"),
      hypotheses: {
        load: loadLiveHypotheses,
        template: () => getMoveTemplate("third-alternative"),
      },
    });
  }
}

/** Contract fixture provider. Never the production default. */
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
    return {
      primaryMove: sorted[0] ?? null,
      alternatives: sorted.slice(1, 3),
      degraded: false,
      selectionBoundary: "contract-fixture-provider",
    };
  }

  async triageMove(request: TriageMovesRequest): Promise<TriageMovesResult> {
    const candidate = this.fixtures.triageMoves?.[request.fellowId] ?? null;
    if (candidate === null)
      return { move: null, degraded: false, selectionBoundary: "contract-fixture-provider" };
    const problemRef = candidate.refs.find((ref) => ref.startsWith("P-"));
    if (problemRef !== undefined) {
      const assignment = request.assignments.find((a) => a.problem_id === problemRef);
      if (assignment?.role === "observer" && PROMOTION_MOVE_KINDS.has(candidate.move)) {
        return {
          move: null,
          degraded: false,
          selectionBoundary: "contract-fixture-provider-permission-filtered",
        };
      }
    }
    return { move: candidate, degraded: false, selectionBoundary: "contract-fixture-provider" };
  }
}
