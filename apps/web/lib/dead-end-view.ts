import type { DeadEndRetryWhen, DeadEndsListQuery, DeadEndsListResponse } from "@asimposium/contracts";

/** Canonical public query shared by exact-item links and both reading faces. */
export function deadEndsQueryString(query: DeadEndsListQuery = {}): string {
  const parameters = new URLSearchParams();
  if (query.target !== undefined) parameters.set("target", query.target);
  if (query.include_superseded === "true" || query.include_superseded === "1")
    parameters.set("include_superseded", "true");
  return parameters.size === 0 ? "" : `?${parameters}`;
}

export function deadEndsPagePath(problemId: string, query: DeadEndsListQuery = {}): string {
  return `/p/${encodeURIComponent(problemId)}/dead-ends${deadEndsQueryString(query)}`;
}

/** Bind a validated public response to the requested problem and history view. */
export function deadEndsMatchView(
  problemId: string,
  face: DeadEndsListResponse,
  includeSuperseded: boolean,
  target?: string,
): boolean {
  const ids = new Set<string>();
  if (face.problem_id !== problemId) return false;
  if (
    target !== undefined &&
    (face.dead_ends.length !== 1 || face.dead_ends[0]?.dead_end_id !== target)
  ) return false;
  for (const item of face.dead_ends) {
    if (
      item.problem_id !== problemId ||
      ids.has(item.dead_end_id) ||
      (target === undefined && !includeSuperseded && item.superseded_by != null)
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
