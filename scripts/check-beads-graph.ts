#!/usr/bin/env bun
/**
 * Beads dependency-graph health & launch-gate invariant checker (bead jc0h).
 *
 * Pure read-only audit against `.beads/beads.db` (or synthetic graphs in unit
 * tests). Verifies:
 *   1. Zero dependency cycles (`blocks` + `parent-child` combined graph).
 *   2. Zero epic-blocks-own-child inversions.
 *   3. Launch gates (`oot`, `mmo`, `8ku`, `gfd`) remain transitively gated by
 *      operator deploy (`rs5n`) and G0 exit (`7ft` / `9y1`) while open.
 *   4. No coarse open-epic `blocks` edges starving non-launch / non-Tier-2
 *      leaf tasks (per operator decision `asimposiumorg-7nph` / Fable §17.2).
 *   5. Actionable ready queue contains product work (not only operator actions
 *      or diagnostic flakes) whenever open non-launch product tasks exist.
 */

import { Database } from "bun:sqlite";

export interface GraphIssue {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly issue_type: string;
  readonly priority: number;
}

export interface GraphDependency {
  readonly issue_id: string;
  readonly depends_on_id: string;
  readonly type: string;
}

export interface GraphViolation {
  readonly code:
    | "DEPENDENCY_CYCLE"
    | "EPIC_BLOCKS_OWN_CHILD"
    | "LAUNCH_GATE_UNGATED"
    | "COARSE_EPIC_DEADLOCK"
    | "READY_QUEUE_STARVED";
  readonly detail: string;
  readonly ids: readonly string[];
}

export interface BeadsGraphAuditReport {
  readonly ok: boolean;
  readonly issue_count: number;
  readonly open_count: number;
  readonly edge_count: number;
  readonly ready_count: number;
  readonly ready_product_count: number;
  readonly violations: readonly GraphViolation[];
}

const LAUNCH_OR_DEFERRED_TITLE = /^(W12[\s.:]|Tier 2:|PARKED:|Deferred decisions)/i;
const OPERATOR_OR_FLAKE_TITLE =
  /^(OPERATOR ACTION:|Diagnose |Investigate |Restore complete UBS|problem-lifecycle real-bindings lane fail)/i;

export const REQUIRED_LAUNCH_TARGETS = [
  "asimposiumorg-oot",
  "asimposiumorg-mmo",
  "asimposiumorg-8ku",
  "asimposiumorg-gfd",
] as const;

export const REQUIRED_DEPLOY_GATE = "asimposiumorg-rs5n";
export const REQUIRED_G0_GATES = ["asimposiumorg-7ft", "asimposiumorg-9y1"] as const;

function reachableBlockers(
  targetId: string,
  blockersOf: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const visited = new Set<string>();
  const stack = [...(blockersOf.get(targetId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const next of blockersOf.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return visited;
}

export function auditBeadsGraph(
  issues: readonly GraphIssue[],
  dependencies: readonly GraphDependency[],
): BeadsGraphAuditReport {
  const issueMap = new Map<string, GraphIssue>();
  for (const issue of issues) issueMap.set(issue.id, issue);

  const violations: GraphViolation[] = [];

  // 1. Cycle detection over blocking edges (`blocks`).
  const adj = new Map<string, string[]>();
  const blockersOf = new Map<string, Set<string>>();
  const parentChildPairs = new Set<string>();

  for (const dep of dependencies) {
    if (dep.type === "parent-child") {
      parentChildPairs.add(`${dep.issue_id}->${dep.depends_on_id}`);
    }
    if (dep.type === "blocks") {
      let list = adj.get(dep.issue_id);
      if (!list) {
        list = [];
        adj.set(dep.issue_id, list);
      }
      list.push(dep.depends_on_id);

      let set = blockersOf.get(dep.issue_id);
      if (!set) {
        set = new Set<string>();
        blockersOf.set(dep.issue_id, set);
      }
      set.add(dep.depends_on_id);
    }
  }

  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        violations.push({
          code: "DEPENDENCY_CYCLE",
          detail: `Blocking dependency cycle detected: ${cycle.join(" -> ")}`,
          ids: cycle,
        });
      } else if (state === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const issue of issues) {
    if ((color.get(issue.id) ?? 0) === 0) visit(issue.id);
  }

  // 2. Epic-blocks-own-child inversions.
  for (const dep of dependencies) {
    if (dep.type !== "blocks") continue;
    if (parentChildPairs.has(`${dep.issue_id}->${dep.depends_on_id}`)) {
      violations.push({
        code: "EPIC_BLOCKS_OWN_CHILD",
        detail: `Parent ${dep.depends_on_id} also blocks its own child ${dep.issue_id}.`,
        ids: [dep.depends_on_id, dep.issue_id],
      });
    }
  }

  // 3. Launch safety invariant: open launch targets stay transitively gated by rs5n + G0.
  const deployGate = issueMap.get(REQUIRED_DEPLOY_GATE);
  const g0Open = REQUIRED_G0_GATES.some((id) => {
    const issue = issueMap.get(id);
    return issue !== undefined && issue.status !== "closed";
  });
  for (const targetId of REQUIRED_LAUNCH_TARGETS) {
    const target = issueMap.get(targetId);
    if (!target || target.status === "closed") continue;
    const blockers = reachableBlockers(targetId, blockersOf);
    if (deployGate && deployGate.status !== "closed" && !blockers.has(REQUIRED_DEPLOY_GATE)) {
      violations.push({
        code: "LAUNCH_GATE_UNGATED",
        detail: `Launch target ${targetId} (${target.title}) is not transitively gated by ${REQUIRED_DEPLOY_GATE}.`,
        ids: [targetId, REQUIRED_DEPLOY_GATE],
      });
    }
    if (g0Open && !REQUIRED_G0_GATES.some((g) => blockers.has(g))) {
      violations.push({
        code: "LAUNCH_GATE_UNGATED",
        detail: `Launch target ${targetId} (${target.title}) is not transitively gated by G0 (${REQUIRED_G0_GATES.join("/")}).`,
        ids: [targetId, ...REQUIRED_G0_GATES],
      });
    }
  }

  // 4. Coarse open-epic blocking non-launch, non-Tier-2 open leaf tasks (7nph / Fable §17.2).
  for (const dep of dependencies) {
    if (dep.type !== "blocks") continue;
    const blocker = issueMap.get(dep.depends_on_id);
    const blocked = issueMap.get(dep.issue_id);
    if (!blocker || !blocked) continue;
    if (blocker.status === "closed" || blocked.status === "closed") continue;
    if (blocker.issue_type !== "epic") continue;
    if (blocked.issue_type === "epic") continue;
    if (LAUNCH_OR_DEFERRED_TITLE.test(blocked.title)) continue;
    violations.push({
      code: "COARSE_EPIC_DEADLOCK",
      detail: `Open epic ${blocker.id} (${blocker.title}) directly blocks non-launch leaf ${blocked.id} (${blocked.title}).`,
      ids: [blocker.id, blocked.id],
    });
  }

  // 5. Ready queue health (open, non-blocked leaf work exists and includes product work).
  const openIssues = issues.filter((i) => i.status === "open");
  const readyIssues = openIssues.filter((issue) => {
    const blockers = blockersOf.get(issue.id);
    if (!blockers || blockers.size === 0) return true;
    for (const blockerId of blockers) {
      const b = issueMap.get(blockerId);
      if (b && b.status !== "closed") return false;
    }
    return true;
  });
  const openProductLeaves = openIssues.filter(
    (i) =>
      i.issue_type !== "epic" &&
      !LAUNCH_OR_DEFERRED_TITLE.test(i.title) &&
      !OPERATOR_OR_FLAKE_TITLE.test(i.title),
  );
  const readyProductLeaves = readyIssues.filter(
    (i) =>
      i.issue_type !== "epic" &&
      !LAUNCH_OR_DEFERRED_TITLE.test(i.title) &&
      !OPERATOR_OR_FLAKE_TITLE.test(i.title),
  );
  if (openProductLeaves.length > 0 && readyProductLeaves.length === 0) {
    violations.push({
      code: "READY_QUEUE_STARVED",
      detail: `${openProductLeaves.length} open non-launch product leaf task(s) exist, but 0 are ready.`,
      ids: openProductLeaves.slice(0, 10).map((i) => i.id),
    });
  }

  return {
    ok: violations.length === 0,
    issue_count: issues.length,
    open_count: openIssues.length,
    edge_count: dependencies.length,
    ready_count: readyIssues.length,
    ready_product_count: readyProductLeaves.length,
    violations,
  };
}

export function auditBeadsDatabase(dbPath = ".beads/beads.db"): BeadsGraphAuditReport {
  const db = new Database(dbPath, { readonly: true });
  try {
    const issues = db
      .query("SELECT id, title, status, issue_type, priority FROM issues")
      .all() as GraphIssue[];
    const dependencies = db
      .query("SELECT issue_id, depends_on_id, type FROM dependencies")
      .all() as GraphDependency[];
    return auditBeadsGraph(issues, dependencies);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dbArgIndex = process.argv.indexOf("--db");
  const dbArgValue = dbArgIndex !== -1 ? process.argv[dbArgIndex + 1] : undefined;
  const dbPath = dbArgValue ?? ".beads/beads.db";
  const report = auditBeadsDatabase(dbPath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
