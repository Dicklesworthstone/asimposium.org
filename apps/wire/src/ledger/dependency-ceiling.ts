import type { ClaimDisposition, ReviewStateFacet } from "./dispositions.ts";
import type { EvidenceClass } from "./evidence-class.ts";

const CLASS_RANK: Readonly<Record<EvidenceClass, number>> = {
  assertion: 0,
  heuristic: 1,
  citation: 2,
  computation: 3,
  certified: 4,
};

export interface PremiseStanding {
  /** All status-bearing inputs were read, verified and folded at this cut. */
  readonly complete: boolean;
  readonly disposition: ClaimDisposition | null;
  readonly review_state: ReviewStateFacet | null;
  readonly stale: boolean;
  readonly latest_version: number | null;
  /** Minimum class of eligible supporting evidence; assertion when none exists. */
  readonly own_ceiling: EvidenceClass | null;
}

export interface CeilingNode {
  readonly target: string;
  /** null means unknown history, never an empty dependency list. */
  readonly dependencies: readonly string[] | null;
  readonly standing: PremiseStanding;
}

export interface DependencyCeiling {
  readonly complete: boolean;
  readonly ceiling: EvidenceClass | null;
  /** One deterministic shortest path to a limiting or unavailable premise. */
  readonly weakest_path: readonly string[];
  readonly reason:
    | "weakest-evidence"
    | "source-unavailable"
    | "dependency-history-unavailable"
    | "dependency-cycle"
    | "premise-not-current"
    | "premise-contested"
    | "premise-inactive";
}

const INACTIVE = new Set<ClaimDisposition>(["draft", "malformed", "refuted", "withdrawn", "superseded"]);

function comparePath(left: readonly string[], right: readonly string[]): number {
  if (left.length !== right.length) return left.length - right.length;
  const l = left.join("\u0000");
  const r = right.join("\u0000");
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Fable §6.5: dependency strength is a minimum, not a vote or a review count.
 * This read-only assessment never mutates the disposition machine. Unknown
 * history and inactive/contested premises cannot supply a favorable ceiling.
 * Every exact version is a separate node; a later head never replaces a pin.
 */
export function computeDependencyCeilings(
  nodes: readonly CeilingNode[],
): ReadonlyMap<string, DependencyCeiling> {
  const byTarget = new Map<string, CeilingNode>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (byTarget.has(node.target)) duplicates.add(node.target);
    byTarget.set(node.target, node);
  }
  const local = new Map<string, DependencyCeiling>();
  const edges = new Map<string, readonly string[]>();
  const unknown = (
    target: string,
    reason: DependencyCeiling["reason"],
  ): DependencyCeiling => ({ complete: false, ceiling: null, weakest_path: [target], reason });

  // Only node-local assessments may be shared. A recursive DFS result can
  // contain an ancestor's back edge; caching it gives other roots an open or
  // non-shortest cycle witness, and can conceal a nearer unavailable source.
  for (const target of [...byTarget.keys()].sort()) {
    const node = byTarget.get(target)!;
    const state = node.standing;
    const version = Number(target.split("@")[1]);
    let result: DependencyCeiling;
    if (
      duplicates.has(target) || nodes.length > 64 ||
      !state.complete || state.stale || state.disposition === null ||
      state.own_ceiling === null || !Object.hasOwn(CLASS_RANK, state.own_ceiling) ||
      !/^C-[0-9]+@[1-9][0-9]*$/.test(target) ||
      !Number.isSafeInteger(version) || version < 1 ||
      state.latest_version === null || !Number.isSafeInteger(state.latest_version) ||
      state.latest_version < version
    ) {
      result = unknown(target, "source-unavailable");
    } else if (state.latest_version > version) {
      result = unknown(target, "premise-not-current");
    } else if (INACTIVE.has(state.disposition)) {
      result = unknown(target, "premise-inactive");
    } else if (state.disposition === "disputed" || state.review_state === "contested") {
      result = unknown(target, "premise-contested");
    } else if (node.dependencies === null) {
      result = unknown(target, "dependency-history-unavailable");
    } else {
      result = {
        complete: true,
        ceiling: state.own_ceiling,
        weakest_path: [target],
        reason: "weakest-evidence",
      };
      edges.set(target, [...new Set(node.dependencies)].sort());
    }
    local.set(target, result);
  }
  for (const dependencies of edges.values()) {
    for (const target of dependencies) {
      if (!local.has(target)) local.set(target, unknown(target, "source-unavailable"));
    }
  }

  // Sorted breadth-first traversal yields the shortest, then lexically first,
  // exact-version path. Unavailable nodes are endpoints, never trusted bridges.
  const pathsFrom = (root: string): Map<string, readonly string[]> => {
    const paths = new Map<string, readonly string[]>([[root, [root]]]);
    const queue = [root];
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      for (const child of edges.get(parent) ?? []) {
        if (paths.has(child)) continue;
        paths.set(child, [...paths.get(parent)!, child]);
        queue.push(child);
      }
    }
    return paths;
  };
  const paths = new Map<string, Map<string, readonly string[]>>();
  const cycles = new Map<string, readonly string[]>();
  for (const root of edges.keys()) {
    const reachable = pathsFrom(root);
    paths.set(root, reachable);
    for (const [target, path] of reachable) {
      if (!edges.get(target)?.includes(root)) continue;
      const candidate = [...path, root];
      const current = cycles.get(root);
      if (!current || comparePath(candidate, current) < 0) cycles.set(root, candidate);
    }
  }

  const output = new Map<string, DependencyCeiling>();
  for (const root of [...local.keys()].sort()) {
    let result = local.get(root)!;
    const consider = (candidate: DependencyCeiling): void => {
      if (!candidate.complete) {
        if (result.complete || comparePath(candidate.weakest_path, result.weakest_path) < 0)
          result = candidate;
      } else if (
        result.complete && candidate.ceiling !== null && result.ceiling !== null &&
        (CLASS_RANK[candidate.ceiling] < CLASS_RANK[result.ceiling] ||
          (CLASS_RANK[candidate.ceiling] === CLASS_RANK[result.ceiling] &&
            comparePath(candidate.weakest_path, result.weakest_path) < 0))
      ) {
        result = candidate;
      }
    };
    for (const [target, path] of paths.get(root) ?? []) {
      consider({ ...local.get(target)!, weakest_path: path });
      const cycle = cycles.get(target);
      if (cycle) consider({
        complete: false, ceiling: null, reason: "dependency-cycle",
        weakest_path: [...path, ...cycle.slice(1)],
      });
    }
    output.set(root, result);
  }
  return output;
}
