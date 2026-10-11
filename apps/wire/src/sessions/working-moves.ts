import {
  type NextMoveCandidate,
  NextMoveCandidateSchema,
  type ProblemRole,
} from "@asimposium/contracts";
import { neutralizeUntrustedBody, type PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import { filterMovesByPermissions } from "../mega-commands/move-permissions.ts";
import {
  type MegaCommandsMoveProvider,
  TruthfulProductionMovesProvider,
} from "../mega-commands/provider.ts";

export interface WorkingMovesPackInput {
  readonly db: D1Database;
  readonly problemId: string;
  readonly sessionId: string;
  readonly credential: FellowCredentialBinding;
  readonly role: ProblemRole | "none";
  readonly cursor: number;
  readonly effectivePermissions: Record<string, boolean>;
  readonly promotionLimited?: boolean;
}

export interface WorkingMovesPackSection {
  readonly candidates: PackCandidate[];
  readonly omitted: { reason: string; detail: string }[];
  readonly primaryMove: NextMoveCandidate | null;
  readonly alternatives: readonly NextMoveCandidate[];
  readonly degraded: boolean;
}

const FAILURE_DETAILS = {
  MOVES_CURSOR_CHANGED:
    "working-moves: public state changed during selection; refresh this working pack for a coherent recommendation.",
  MOVES_CURSOR_INVALID: "working-moves: the captured public cursor could not be verified.",
  MOVES_SCOPE_UNAVAILABLE:
    "working-moves: canonical move discovery currently requires a listed public problem and current membership.",
  MOVES_PARTIAL:
    "working-moves: at least one bounded source was incomplete; available recommendations are not a complete search.",
  MOVES_UNAVAILABLE:
    "working-moves: canonical selection is temporarily unavailable; refresh this pack before choosing a move.",
} as const;

function unavailable(code = "MOVES_UNAVAILABLE"): WorkingMovesPackSection {
  return {
    candidates: [],
    omitted: [
      {
        reason: "moves_unavailable",
        detail: Object.hasOwn(FAILURE_DETAILS, code)
          ? FAILURE_DETAILS[code as keyof typeof FAILURE_DETAILS]
          : FAILURE_DETAILS.MOVES_UNAVAILABLE,
      },
    ],
    primaryMove: null,
    alternatives: [],
    degraded: true,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Adapt the same bounded scientific selector used by /next into one whole
 * pack item. All instructions originate in canonical move builders: statements,
 * witnesses, reports and workshop prose remain behind their fenced read URLs.
 * A head mismatch omits the entire recommendation rather than mixing cuts. */
export async function readWorkingMovesPack(
  input: WorkingMovesPackInput,
  provider: MegaCommandsMoveProvider = new TruthfulProductionMovesProvider(),
): Promise<WorkingMovesPackSection> {
  try {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0)
      return unavailable("MOVES_CURSOR_INVALID");
    const result = await provider.nextMoves({
      db: input.db,
      problemId: input.problemId,
      fellowId: input.credential.fellowId,
      credential: input.credential,
      role: input.role,
      effectivePermissions: input.effectivePermissions,
      capturedCursor: input.cursor,
      publicWritesLimited: input.promotionLimited,
    });
    if (
      result.alternatives.length > 2 ||
      (result.primaryMove === null && result.alternatives.length)
    )
      return unavailable();
    const rawMoves = result.primaryMove ? [result.primaryMove, ...result.alternatives] : [];
    if (rawMoves.length > 0 && result.capturedCursor !== input.cursor)
      return unavailable("MOVES_CURSOR_CHANGED");
    if (result.degraded && rawMoves.length === 0) return unavailable(result.degradedReason);

    for (const move of rawMoves) {
      if (!NextMoveCandidateSchema.safeParse(move).success || !move.refs.includes(input.problemId))
        return unavailable();
      const preparation = move.contract.preparation;
      if (
        !record(preparation) ||
        preparation.problem_id !== input.problemId ||
        (move.move !== "idle-close" && preparation.captured_cursor !== input.cursor)
      )
        return unavailable("MOVES_CURSOR_CHANGED");
    }

    // Caller restrictions can only reduce the provider's current central
    // authorization; stale UI hints cannot create authority.
    const effectivePermissions = Object.fromEntries(
      ["read", "session_open", "workshop_push", "promote", "review"].map((permission) => [
        permission,
        input.effectivePermissions[permission] === true &&
          result.effectivePermissions?.[permission] === true,
      ]),
    );
    const permitted = filterMovesByPermissions(
      rawMoves,
      effectivePermissions,
      input.promotionLimited,
    );
    const primaryMove = permitted[0] ?? null;
    const alternatives = permitted.slice(1, 3);
    const omitted: WorkingMovesPackSection["omitted"] = [];
    if (result.degraded)
      omitted.push({ reason: "moves_degraded", detail: FAILURE_DETAILS.MOVES_PARTIAL });
    if (permitted.length < rawMoves.length)
      omitted.push({
        reason: "moves_permission_filtered",
        detail:
          "working-moves: recommendations requiring unavailable permissions or public-write quota were omitted.",
      });
    const body = JSON.stringify({
      captured_cursor: input.cursor,
      primary_move: primaryMove,
      alternatives,
      degraded: result.degraded,
      selection_boundary:
        result.selectionBoundary ??
        "Canonical bounded move selection. A recommendation is not an assignment, reservation, result or authorization.",
    });
    // Leave room below the renderer's hard ceiling. Do not truncate a contract
    // or silently detach its alternatives; the composer budgets this whole item.
    if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000)
      return {
        ...unavailable(),
        omitted: [
          {
            reason: "item_too_large",
            detail:
              "working-moves: the complete ranked contracts exceed the pack item limit; read /next for the full recommendation.",
          },
        ],
      };
    return {
      candidates: [
        {
          kind: primaryMove ? "move" : "standing-context",
          id: primaryMove ? "SYS-working-moves" : "SYS-working-moves-empty",
          scope: "system",
          untrusted: false,
          tokens: 1,
          body,
          why_included: primaryMove
            ? "canonical highest-priority permitted move and at most two alternatives at this public cursor"
            : "canonical bounded selection found no permitted move at this public cursor",
          stable_prefix: 30,
        },
      ],
      omitted,
      primaryMove,
      alternatives,
      degraded: result.degraded,
    };
  } catch {
    // SQL and loader errors may contain private identifiers. Only the fixed
    // recovery text above is reflected into an authenticated pack.
    return unavailable();
  }
}
