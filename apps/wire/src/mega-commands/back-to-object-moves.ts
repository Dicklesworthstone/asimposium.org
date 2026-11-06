import {
  getMoveTemplate,
  type NextMoveCandidate,
  NextMoveCandidateSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadReviewQueue } from "../discovery/review-queue-service.ts";
import { loadProofGapMove } from "./gap-moves-service.ts";
import { loadLedgerMoves } from "./ledger-moves.ts";
import {
  type CeremonyMoveContext,
  type CeremonyNeedReaders,
  checkCeremonyBreaker,
} from "./materiality.ts";

// Keep the event classifier usable by native ledger/replay code without
// importing the Worker's discovery service graph. Only this live move adapter
// composes the current canonical scientific readers.
const ceremonyNeeds: CeremonyNeedReaders = {
  claims: (db, problemId, viewer, permissions, cursor) =>
    loadLedgerMoves(
      db,
      problemId,
      viewer,
      permissions,
      { loadQueue: loadReviewQueue, templateFor: getMoveTemplate },
      cursor,
      { includeUnlisted: true },
    ),
  gap: loadProofGapMove,
};

export const BACK_TO_OBJECT_BOUNDARY =
  "After 25 process events without an object-level increment, focus on the oldest eligible exact-version claim need among two canonical review pages, otherwise the canonical unowned proof-gap selection. Current content controls, withdrawals and reviewer eligibility still apply. Bounded selection is not an exhaustive search, an assignment or a scientific result.";

export interface BackToObjectMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectBackToObjectMove(
  db: D1Database,
  problemId: string,
  cursor: number,
  problemStatus: string = "active",
  context?: CeremonyMoveContext,
): Promise<BackToObjectMoveResult> {
  try {
    const ceremony = await checkCeremonyBreaker(
      db,
      problemId,
      cursor,
      problemStatus,
      context,
      ceremonyNeeds,
    );
    if (!ceremony.active) {
      return { move: null, degraded: false };
    }

    const template = getMoveTemplate("back-to-the-object");
    const oldestNeed = ceremony.oldestNeed;
    const selected = ceremony.selectedMove;
    if (!oldestNeed || !selected) return { move: null, degraded: ceremony.degraded };
    const preparation = selected.contract.preparation as Record<string, unknown> | undefined;
    if (
      !NextMoveCandidateSchema.safeParse(selected).success ||
      !["review", "add-refuter", "close-gap"].includes(selected.move) ||
      selected.contract.availability !== "available" ||
      selected.refs[0] !== problemId ||
      preparation?.problem_id !== problemId ||
      preparation.captured_cursor !== cursor
    )
      return { move: null, degraded: true };

    return {
      move: {
        move: "back-to-the-object",
        why: `${ceremony.totalEventsInWindow} recent events contain no object-level increment. Resume the oldest eligible examined need: ${oldestNeed.description}`,
        refs: selected.refs,
        contract: {
          ...selected.contract,
          move: template.move,
          title: template.title,
          trigger: template.trigger,
          description: template.description,
          preparation: {
            ...preparation,
            focus_move: selected.move,
            recent_events_scanned: ceremony.totalEventsInWindow,
            object_increments_found: ceremony.objectEventCountInWindow,
            target_need: oldestNeed,
          },
        },
        selection_boundary: BACK_TO_OBJECT_BOUNDARY,
      },
      degraded: ceremony.degraded,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
