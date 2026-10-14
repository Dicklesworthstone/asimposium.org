import type { D1Database } from "@cloudflare/workers-types";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  type PremiseAssessment,
  prepareDependencyAssessment,
} from "./claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  type DependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "./claim-dependency-closure.ts";

export interface ClaimDependencySnapshot {
  readonly problem: string;
  readonly target: string;
  readonly through: number;
  readonly closure: DependencyClosure;
  readonly assessments: ReadonlyMap<string, PremiseAssessment>;
}

/** Shared exact-version scientific input for non-page consumers. Publications
 * and their scientific timelines are read in ONE D1 batch, with the existing
 * 64-node and per-query row/byte bounds. Current withholding still wins over
 * the captured cursor. Missing/corrupt science stays explicitly incomplete;
 * storage failure is never converted into an empty or favorable assessment.
 * No workshop, mutable dependency projection or write participates.
 */
export async function readClaimDependencySnapshot(
  db: D1Database,
  problem: string,
  through: number,
  target: string,
): Promise<ClaimDependencySnapshot> {
  // prepareDependencyClosure validates the exact target and cursor before any
  // I/O. Keep that canonical validation even when the timeline reader evolves.
  const publications = prepareDependencyClosure(db, problem, through, target);
  const science = prepareDependencyAssessment(db, problem, through, target);
  const results = await db.batch([publications, science]);
  if (
    results.length !== 2 ||
    !Array.isArray(results[0]?.results) ||
    !Array.isArray(results[1]?.results)
  ) {
    throw new Error("The claim dependency snapshot is incomplete.");
  }
  const rows = results[0].results as DependencyClosureRow[];
  const sources = results[1].results as DependencyScientificRow[];
  const closure = await composeDependencyClosure(rows, problem, target);
  const assessments = await composeDependencyAssessment(
    rows, closure, sources, problem, target, through,
  );
  return { problem, target, through, closure, assessments };
}
