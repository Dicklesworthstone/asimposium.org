/**
 * W5.3 claim-dependency cycle check (P10: cycles are errors). Given the
 * existing depends_on edges on a problem and a proposed new edge, decide whether
 * the new edge would close a cycle. The DAG invariant is enforced at write time
 * — this is the pure check the route runs before committing an edge.
 *
 * An edge `claim -> dependsOn` means `claim` depends on `dependsOn`; a cycle is
 * a path from `dependsOn` back to `claim` through existing edges.
 */

export interface ClaimDepEdge {
  readonly claimId: string;
  readonly dependsOnClaimId: string;
}

/**
 * True exactly when adding `claimId -> dependsOnClaimId` would close a cycle.
 * Walks the existing edges from `dependsOnClaimId`; if `claimId` is reachable,
 * the new edge closes a loop. Pure over the edge set.
 */
export function wouldCreateCycle(
  existing: readonly ClaimDepEdge[],
  claimId: string,
  dependsOnClaimId: string,
): boolean {
  if (claimId === dependsOnClaimId) return true;
  // Index: a claim -> the claims it depends on. Adding `claimId` depends-on
  // `dependsOnClaimId` closes a cycle exactly when `claimId` is reachable from
  // `dependsOnClaimId` by following depends-on edges.
  const dependenciesOf = new Map<string, string[]>();
  for (const edge of existing) {
    const list = dependenciesOf.get(edge.claimId) ?? [];
    list.push(edge.dependsOnClaimId);
    dependenciesOf.set(edge.claimId, list);
  }
  const seen = new Set<string>();
  const queue: string[] = [dependsOnClaimId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === claimId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependency of dependenciesOf.get(current) ?? []) {
      queue.push(dependency);
    }
  }
  return false;
}

/**
 * Validate a set of proposed edges against the existing edges: each must not
 * close a cycle. Returns the first offending edge, or null when all are clean.
 */
export function firstCyclicEdge(
  existing: readonly ClaimDepEdge[],
  proposed: readonly ClaimDepEdge[],
): ClaimDepEdge | null {
  const acc = [...existing];
  for (const edge of proposed) {
    if (wouldCreateCycle(acc, edge.claimId, edge.dependsOnClaimId)) {
      return edge;
    }
    acc.push(edge);
  }
  return null;
}
