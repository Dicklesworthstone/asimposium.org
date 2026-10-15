import type { HonorsGatedStatus } from "@asimposium/contracts";
import type { ClaimGraphSummary } from "../ledger/claim-graph-read.ts";
import type { ScientificDisposition } from "../ledger/scientific-disposition.ts";

/** An artifact is a reason for a badge, never an alternative disposition.
 * Reject stale/missing folds before spending another bounded scientific read. */
export function honorsCandidateVersion(fold: ScientificDisposition | undefined): number | null {
  if (!fold || fold.disposition !== "strongly-supported" || fold.stale !== false ||
      !Number.isSafeInteger(fold.currentVersion) || fold.currentVersion === null ||
      fold.currentVersion < 1) return null;
  return fold.currentVersion;
}

/** The caller supplies the shared graph reader's validated summary, not raw
 * author JSON. This is recognition policy over the canonical scientific fold,
 * not another evaluator. Neither a class nor a dependency can promote a claim.
 * Prose proofs can be strongly supported while their evidence class remains
 * assertion. Only the machine-checked badge requires a certified chain. */
export function claimHonorsStatus(
  fold: ScientificDisposition | undefined,
  graph: ClaimGraphSummary,
  expected: { readonly problem: string; readonly claim: string; readonly through: number },
): Exclude<HonorsGatedStatus, "resolved"> | null {
  const version = honorsCandidateVersion(fold);
  if (version === null || !fold ||
      graph.problem !== expected.problem || graph.target !== `${expected.claim}@${version}` ||
      graph.through !== expected.through || !Number.isSafeInteger(expected.through) ||
      expected.through < 0 ||
      graph.closure.scope !== "publication-pins" || graph.closure.complete !== true ||
      graph.closure.unavailable_references !== 0 ||
      graph.standing.complete !== true || graph.standing.stale !== false ||
      graph.standing.latest_version !== version ||
      graph.standing.disposition !== "strongly-supported" ||
      graph.chain.complete !== true || graph.chain.reason !== "weakest-evidence" ||
      graph.chain.ceiling === null) return null;
  return fold.context.has_certified_artifact === true &&
    graph.standing.own_ceiling === "certified" && graph.chain.ceiling === "certified"
    ? "machine-checked" : "strongly-supported";
}
