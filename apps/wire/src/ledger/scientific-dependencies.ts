import { type ClaimDependencyPin, ClaimDependencyPinsSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  type PremiseAssessment,
  prepareDependencyAssessment,
} from "./claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "./claim-dependency-closure.ts";
import { checkedScientificPayload, ScientificInputError } from "./scientific-checks.ts";
import type { ScientificDisposition, ScientificRow } from "./scientific-disposition.ts";

/** Dependency health is a facet, not a disposition-machine transition. Assess
 * the pinned children: a historical root's own newer version must not rewrite
 * that old statement's standing. Every child chain includes its transitive
 * premises and the canonical cycle, byte, row and traversal bounds. */
export function withPremiseStaleness(
  fold: ScientificDisposition,
  pins: readonly ClaimDependencyPin[] | null,
  assessments: ReadonlyMap<string, PremiseAssessment>,
  complete: boolean,
): ScientificDisposition {
  if (fold.stale || pins === null || pins.length === 0) return fold;
  const stale = !complete || pins.some((pin) =>
    assessments.get(`${pin.claim_id}@${pin.version}`)?.chain.complete !== true,
  );
  return stale ? { ...fold, stale: true } : fold;
}

/** Enrich a bounded headline selection with the same immutable graph and
 * scientific assessment used by exact claim reads. The raw scientific fold
 * stays dependency-independent, so assessment never recursively re-enters this
 * reader. Each root is processed sequentially with the canonical read budgets. */
export async function readPremiseAwareDisposition(
  db: D1Database,
  problem: string,
  through: number,
  claim: string,
  rows: readonly ScientificRow[],
  fold: ScientificDisposition,
): Promise<ScientificDisposition> {
  if (fold.stale || fold.currentVersion === null) return fold;
  const publication = rows.find((row) => row.object_id === claim &&
    row.object_version === fold.currentVersion &&
    (row.type === "claim.created" || row.type === "claim.revised"));
  if (!publication?.payload_json) return { ...fold, stale: true };
  let pins: ClaimDependencyPin[];
  try {
    const payload = await checkedScientificPayload({ ...publication, payload_json: publication.payload_json });
    // Legacy publications without a pin list retain their existing unknown
    // dependency-history boundary; never substitute today's claim_deps rows.
    if (payload.dependency_pins === undefined) return fold;
    const parsed = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
    if (!parsed.success || parsed.data.some((pin) => pin.claim_id === claim))
      return { ...fold, stale: true };
    pins = parsed.data;
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    return { ...fold, stale: true };
  }
  if (pins.length === 0) return fold;
  const target = `${claim}@${fold.currentVersion}`;
  const [publications, science] = await db.batch([
    prepareDependencyClosure(db, problem, through, target),
    prepareDependencyAssessment(db, problem, through, target),
  ]);
  if (!publications || !science || !publications.success || !science.success)
    throw new Error("Claim dependency snapshot unavailable");
  const sources = publications.results as DependencyClosureRow[];
  const closure = await composeDependencyClosure(sources, problem, target);
  const assessments = await composeDependencyAssessment(
    sources, closure, science.results as DependencyScientificRow[], problem, target, through,
  );
  return withPremiseStaleness(fold, pins, assessments, closure.complete);
}
