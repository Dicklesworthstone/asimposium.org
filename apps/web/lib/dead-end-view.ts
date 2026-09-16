import type { DeadEndRetryWhen, DeadEndsListResponse } from "@asimposium/contracts";

/** Bind a validated public response to the requested problem and history view. */
export function deadEndsMatchView(
  problemId: string,
  face: DeadEndsListResponse,
  includeSuperseded: boolean,
): boolean {
  const ids = new Set<string>();
  if (face.problem_id !== problemId) return false;
  for (const item of face.dead_ends) {
    if (
      item.problem_id !== problemId ||
      ids.has(item.dead_end_id) ||
      (!includeSuperseded && item.superseded_by != null)
    ) {
      return false;
    }
    ids.add(item.dead_end_id);
  }
  return true;
}

/** Describe the recorded predicate; its presence is not evidence that it fired. */
export function deadEndRetryLabel(trigger: DeadEndRetryWhen | null | undefined): string {
  if (trigger == null) return "No machine-readable retry trigger was recorded.";
  switch (trigger.kind) {
    case "claim-reaches":
      return `Revisit when claim ${trigger.claim_id} reaches ${trigger.reaches}.`;
    case "statement-revised":
      return "Revisit when the problem statement is revised.";
    case "gap-closed":
      return `Revisit when gap ${trigger.gap_id} is closed.`;
  }
}
