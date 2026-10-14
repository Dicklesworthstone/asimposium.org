import type { PremiseAssessment } from "../ledger/claim-dependency-assessment.ts";
import type { ClaimDependencySnapshot } from "../ledger/claim-dependency-snapshot.ts";
import {
  computeDependencyCeilings,
  type DependencyCeiling,
  type PremiseStanding,
} from "../ledger/dependency-ceiling.ts";

export interface FormalizationFocus {
  readonly target: string;
  readonly priorityRoot: string;
  /** Published edges from the prioritized claim to the selected work target. */
  readonly dependencyPath: readonly string[];
  /** The entire limiting path, including premises that still need review. */
  readonly limitingPath: readonly string[];
  readonly standing: PremiseStanding;
  readonly chain: DependencyCeiling;
  readonly priorityChain: DependencyCeiling;
}

export type FormalizationFocusResult =
  | { readonly kind: "selected"; readonly focus: FormalizationFocus }
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unavailable" };

const CLASSES = new Set(["assertion", "heuristic", "citation", "computation", "certified"]);
const LIVE_DISPOSITIONS = new Set(["open", "disputed", "corroborated", "strongly-supported", "reduced-to"]);
const REVIEW_STATES = new Set(["unreviewed", "review-requested", "under-review", "contested", "independently-checked"]);

function exactTarget(value: string): boolean {
  return typeof value === "string" && value.length <= 64 &&
    /^C-[0-9]+@[1-9][0-9]*$/.exec(value)?.[0] === value &&
    Number.isSafeInteger(Number(value.split("@")[1]));
}

function sameChain(a: DependencyCeiling, b: DependencyCeiling): boolean {
  return a.complete === b.complete && a.ceiling === b.ceiling && a.reason === b.reason &&
    Array.isArray(a.weakest_path) && a.weakest_path.length === b.weakest_path.length &&
    a.weakest_path.every((step, index) => step === b.weakest_path[index]);
}

/** Choose work along the actual limiting publication path of a load-bearing
 * claim, not by author popularity or fabricated graph scores. A weak premise
 * is a formalization target only if its OWN standing is corroborated/disputed
 * (Fable 9.2); an unreviewed leaf does not acquire its parent's review authority.
 *
 * Closed, incomplete or cross-cut inputs refuse selection. An already checked
 * certificate needs no duplicate formalization unless the claim is disputed.
 * This is a recommendation, never publication permission or a truth verdict.
 */
export function pickFormalizationFocus(
  snapshot: ClaimDependencySnapshot,
  expected: {
    readonly problem: string;
    readonly target: string;
    readonly through: number;
    readonly disposition: string;
  },
): FormalizationFocusResult {
  const unavailable = { kind: "unavailable" } as const;
  if (
    snapshot.problem !== expected.problem || snapshot.target !== expected.target ||
    snapshot.through !== expected.through || !Number.isSafeInteger(expected.through) ||
    expected.through < 0 || !exactTarget(expected.target) ||
    !["corroborated", "disputed"].includes(expected.disposition) ||
    snapshot.closure.root_available !== true || snapshot.closure.complete !== true ||
    snapshot.closure.unavailable.length !== 0 || snapshot.closure.nodes.length > 63 ||
    snapshot.closure.edges.length > 1024
  ) return unavailable;

  const targets = [expected.target, ...snapshot.closure.nodes.map((node) => node.target)];
  const known = new Set(targets);
  if (known.size !== targets.length || snapshot.assessments.size !== known.size ||
      !targets.every(exactTarget)) return unavailable;
  const dependencies = new Map(targets.map((target) => [target, new Set<string>()]));
  for (const edge of snapshot.closure.edges) {
    if (edge.available !== true || !known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to)
      return unavailable;
    if (dependencies.get(edge.from)!.has(edge.to)) return unavailable;
    dependencies.get(edge.from)!.add(edge.to);
    if (dependencies.get(edge.from)!.size > 16) return unavailable;
  }
  // Do not let an unrelated row appended to a source response participate.
  const reachable = new Set([expected.target]);
  const pending = [expected.target];
  for (let index = 0; index < pending.length; index++) {
    for (const child of dependencies.get(pending[index]!) ?? []) {
      if (!reachable.has(child)) { reachable.add(child); pending.push(child); }
    }
  }
  if (reachable.size !== known.size) return unavailable;
  // An adverse node can stop the ceiling calculator before its descendants.
  // Still reject a cyclic graph even when the shortest blocker is the root.
  const incoming = new Map(targets.map((target) => [target, 0]));
  for (const children of dependencies.values()) {
    for (const child of children) incoming.set(child, incoming.get(child)! + 1);
  }
  const ordered = targets.filter((target) => incoming.get(target) === 0);
  for (let index = 0; index < ordered.length; index++) {
    for (const child of dependencies.get(ordered[index]!)!) {
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) ordered.push(child);
    }
  }
  if (ordered.length !== known.size) return unavailable;

  const byTarget = new Map<string, PremiseAssessment>();
  for (const target of targets) {
    const assessment = snapshot.assessments.get(target);
    if (!assessment || assessment.scope !== "publication-pins" ||
        assessment.problem !== expected.problem || assessment.target !== target ||
        assessment.through !== expected.through) return unavailable;
    const state = assessment.standing;
    if (state.complete !== true || state.stale !== false || state.latest_version !== Number(target.split("@")[1]) ||
        state.disposition === null || !LIVE_DISPOSITIONS.has(state.disposition) ||
        state.review_state === null || !REVIEW_STATES.has(state.review_state) ||
        state.own_ceiling === null || !CLASSES.has(state.own_ceiling)) return unavailable;
    byTarget.set(target, assessment);
  }
  const root = byTarget.get(expected.target)!;
  if (root.standing.disposition !== expected.disposition) return unavailable;

  // Use the existing pure chain rule, not a second scientific state machine.
  // Cross-check the graph against its summaries before using a path as trusted
  // move metadata; neither a detached edge nor a fabricated ceiling can route work.
  const computed = computeDependencyCeilings(targets.map((target) => ({
    target, dependencies: [...dependencies.get(target)!], standing: byTarget.get(target)!.standing,
  })));
  for (const target of targets) {
    const chain = computed.get(target);
    if (!chain || !sameChain(byTarget.get(target)!.chain, chain) ||
        (!chain.complete && chain.reason !== "premise-contested")) return unavailable;
  }
  const path = root.chain.weakest_path;
  if (path[0] !== expected.target || path.length < 1 || path.length > 64 ||
      new Set(path.map((step) => step.split("@")[0])).size !== path.length)
    return unavailable;

  for (let index = path.length - 1; index >= 0; index--) {
    const target = path[index]!;
    const assessment = byTarget.get(target)!;
    const state = assessment.standing;
    if (state.disposition !== "corroborated" && state.disposition !== "disputed") continue;
    if (state.own_ceiling === "certified" && state.disposition !== "disputed" &&
        state.review_state !== "contested") continue;
    return { kind: "selected", focus: {
      target, priorityRoot: expected.target,
      dependencyPath: path.slice(0, index + 1), limitingPath: [...path],
      standing: { ...state }, chain: { ...assessment.chain, weakest_path: [...assessment.chain.weakest_path] },
      priorityChain: { ...root.chain, weakest_path: [...path] },
    } };
  }
  return { kind: "not-applicable" };
}
