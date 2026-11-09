import type { MoveKind, NextMoveCandidate } from "@asimposium/contracts";

/** Reviews have their own scope and remain available to observers (§9.3). */
export const PROMOTION_MOVE_KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
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
]);

/** Overflow observers keep the same evidence and negative-result authority
 * as the corresponding write routes. Claim promotion is a separate effect. */
const EVIDENCE_MOVE_KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
  "add-refuter",
  "discriminate",
  "formalize",
  "add-refuter-from-friction",
]);
const DEAD_END_MOVE_KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
  "record-dead-end",
  "retry-dead-end",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The existing statement-review route is a review effect, including when
 * a working pack binds its exact problem path and owned session. */
export function isStatementReviewMove(candidate: NextMoveCandidate): boolean {
  const request = candidate.contract?.request;
  return (
    candidate.move === "sharpen-statement" &&
    candidate.contract?.availability === "available" &&
    candidate.contract.target_contract === "/schemas/problems.v1/statement_review_request.json" &&
    record(request) &&
    request.method === "POST" &&
    (request.path === "/v1/problems/{problem_id}/statement-review" ||
      request.path ===
        `/v1/problems/${encodeURIComponent(candidate.refs[0] ?? "")}/statement-review`)
  );
}

/** The public-write quota also covers review. Keep only a genuinely private
 * workshop preparation or session closure while that quota is exhausted. */
export function isPrivatePreparationMove(
  candidate: NextMoveCandidate,
  permissions: Record<string, boolean>,
): boolean {
  if (candidate.move === "idle-close") return permissions.session_open === true;
  if (permissions.workshop_push !== true) return false;
  if (candidate.contract?.availability === "unavailable")
    return candidate.move === "sharpen-statement";
  const request = candidate.contract?.request;
  return (
    record(request) && request.method === "POST" && request.path === "/v1/sessions/{id}/workshop"
  );
}

export function filterMovesByPermissions(
  candidates: readonly NextMoveCandidate[],
  effectivePermissions: Record<string, boolean>,
  publicWritesLimited = false,
): readonly NextMoveCandidate[] {
  return candidates.filter((candidate) => {
    if (effectivePermissions.session_open !== true) return false;
    let effect = candidate.move;
    if (effect === "back-to-the-object") {
      const preparation = candidate.contract?.preparation;
      if (!record(preparation)) return false;
      const focus = preparation.focus_move;
      if (focus !== "review" && focus !== "add-refuter" && focus !== "close-gap") return false;
      effect = focus;
    }
    if (PROMOTION_MOVE_KINDS.has(effect)) {
      const permission = EVIDENCE_MOVE_KINDS.has(effect)
        ? "evidence"
        : DEAD_END_MOVE_KINDS.has(effect)
          ? "dead_end"
          : "promote";
      if (effectivePermissions[permission] !== true) return false;
    }
    if (effect === "sharpen-statement") {
      if (isStatementReviewMove(candidate)) {
        if (effectivePermissions.review !== true) return false;
      } else {
        const request = candidate.contract?.request;
        if (
          !record(request) ||
          request.path !== "/v1/sessions/{id}/workshop" ||
          effectivePermissions.workshop_push !== true
        )
          return false;
      }
    }
    if (effect === "review" && effectivePermissions.review !== true) return false;
    const request = candidate.contract?.request;
    if (
      record(request) &&
      request.path === "/v1/sessions/{id}/workshop" &&
      effectivePermissions.workshop_push !== true
    )
      return false;
    return !publicWritesLimited || isPrivatePreparationMove(candidate, effectivePermissions);
  });
}
