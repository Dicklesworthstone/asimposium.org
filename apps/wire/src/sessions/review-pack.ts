import type { PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { loadLedgerMoves, reviewTargetKey, type LedgerMovesDependencies, type MoveViewer } from "../mega-commands/ledger-moves";

export interface ReviewPackSection {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
  targets: string[];
}

type Selection = Awaited<ReturnType<typeof loadLedgerMoves>>;

/** Adapt already-selected scientific needs; do not implement another ranking,
 * status fold, or independence evaluator in the pack layer. Even when a whole
 * summary is too large, retain the target so brevity cannot change priority. */
export function composeReviewSelectionPack(
  selection: Selection, problemId: string, cursor: number,
  neutralize: (body: string) => string,
): ReviewPackSection {
  const section: ReviewPackSection = { candidates: [], omitted: [], targets: [] };
  if (selection.degraded) section.omitted.push({
    reason: "review_selection_partial",
    detail: "Some canonical review admissions were unavailable or beyond the two-page scan; this is not a complete board-wide queue.",
  });
  if (selection.continuation !== null) section.omitted.push({
    reason: "candidate_limit",
    detail: `Continue live discovery (a new snapshot, not this pack's frozen cut): ${selection.continuation}`,
  });
  const items = new Map(selection.items.map(item => [reviewTargetKey(item), item]));
  const seen = new Set<string>();
  for (const [index, move] of selection.moves.entries()) {
    const target = move.refs[1];
    const item = items.get(`${problemId}/${target}`);
    if (move.move !== "review" || move.refs[0] !== problemId || typeof target !== "string" ||
        /^C-[0-9]+@[1-9][0-9]*$/.exec(target)?.[0] !== target || !item ||
        item.problem_id !== problemId || item.cursor !== cursor || seen.has(target)) {
      throw new Error("REVIEW_PACK_SELECTION_MISMATCH");
    }
    seen.add(target);
    section.targets.push(target);
    const body = JSON.stringify({
      ...item,
      target,
      independence_note: "Sponsor independence is an eligibility filter, not a granted tier. Family, method and capable-of-failure checks are assessed at submission; model names do not establish them.",
    });
    if (body.length > 18000 || neutralize(body).length > 18000) {
      section.omitted.push({ reason: "item_too_large", detail: `eligible-reviews:${target}; read the exact-version claim face` });
      continue;
    }
    section.candidates.push({
      kind: "review-candidate", id: target, scope: "ledger", untrusted: true, tokens: 1,
      body, stable_prefix: 3 + index,
      why_included: "canonical scientific need, ranked by consequence, missing check and age after reviewer eligibility; not permission, support or a reservation",
    });
  }
  if (section.targets.length === 0 && section.omitted.length === 0) section.candidates.push({
    kind: "standing-context", id: "SYS-review-queue-empty", scope: "system", untrusted: false, tokens: 1,
    body: "No eligible sponsor-independent review needs were found in the bounded admissions examined at this cursor. This is not a claim that the whole board is reviewed or scientifically supported.",
    why_included: "state only the examined reviewer-specific baseline", stable_prefix: 3,
  });
  return section;
}

/** Production supplies the canonical queue and renderer from ledger-pack.
 * The public router cannot select a source, evaluator or neutralizer. */
export async function readReviewSelectionPack(
  db: D1Database, problemId: string, cursor: number, reviewer: MoveViewer,
  dependencies: LedgerMovesDependencies, neutralize: (body: string) => string,
): Promise<ReviewPackSection> {
  try {
    const selection = await loadLedgerMoves(db, problemId, reviewer,
      { session_open: true, review: true, promote: false }, dependencies, cursor);
    return composeReviewSelectionPack(selection, problemId, cursor, neutralize);
  } catch {
    // Discovery loss cannot hide otherwise readable workshop/ledger records,
    // invent an empty queue, or fall back to an older, less strict selector.
    return { candidates: [], targets: [], omitted: [{ reason: "review_selection_unavailable",
      detail: "Canonical reviewer-specific selection is unavailable at this pack cursor. Other readable pack records remain usable; retry or use live public discovery." }] };
  }
}
