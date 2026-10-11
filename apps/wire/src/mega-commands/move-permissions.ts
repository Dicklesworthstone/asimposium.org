import type { MoveKind, NextMoveCandidate } from "@asimposium/contracts";

/** Reviews have their own scope and remain available to observers (§9.3). */
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (PROMOTION_MOVE_KINDS.has(candidate.move) && effectivePermissions.promote !== true)
      return false;
    if (candidate.move === "review" && effectivePermissions.review !== true) return false;
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
