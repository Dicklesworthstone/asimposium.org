import { getMoveTemplate, type MoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import {
  parseReviewQueueAfter,
  REVIEW_QUEUE_PAGE_SIZE,
  type ReviewQueueItem,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { ClaimDependencySnapshot } from "../ledger/claim-dependency-snapshot.ts";
import { type FormalizationFocus, pickFormalizationFocus } from "./formalize-dependency-target.ts";

export const FORMALIZE_MAX_PAGES = 2;
// Two bounded scientific queries per examined root, never a per-node N+1 scan.
export const FORMALIZE_MAX_ASSESSMENTS = 4;
export const FORMALIZE_MOVES_BOUNDARY =
  "formalization-needs-v3: prioritize corroborated/disputed roots by verified direct dependency pins within two canonical admission pages; inspect at most four publication-pinned scientific snapshots and choose an eligible work target on the limiting path. A premise must have its own corroborated/disputed standing. Counts belong to the priority root, not its premises. Unknown inputs and capped counts make selection incomplete; this is not a whole-graph optimum or proof of an implication. Ordinary independent checks determine scientific standing.";

export interface FormalizeMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export interface FormalizeMoveSource {
  /** Production shares the public queue's digest checks, dependency pins and
   * scientific fold with claim faces. Never substitute claim_deps counts or an
   * author-writable disposition. All pages use the same captured problem cut. */
  load(
    db: D1Database,
    problemId: string,
    cursor: number,
    after?: string,
  ): Promise<ReviewQueueResponse>;
  /** Omission uses the production single-batch scientific reader, never an
   * invented complete graph. Kept optional for other canonical queue adapters. */
  assess?(
    db: D1Database,
    problemId: string,
    cursor: number,
    target: string,
  ): Promise<ClaimDependencySnapshot>;
  template(): MoveTemplate;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prioritize scientific consequence, then an unresolved dispute, then age.
 * No author popularity, prose length, model brand or raw activity is a signal.
 * A bounded count is a lower bound, not evidence that one capped score wins. */
export function rankFormalizationTargets(items: readonly ReviewQueueItem[]): ReviewQueueItem[] {
  return items
    .filter((item) =>
      item.direct_dependents > 0 &&
      (item.disposition === "corroborated" || item.disposition === "disputed"))
    .sort((a, b) =>
      b.direct_dependents - a.direct_dependents ||
      Number(b.disposition === "disputed") - Number(a.disposition === "disputed") ||
      compareText(a.created_at, b.created_at) ||
      compareText(a.claim_id, b.claim_id));
}

export async function selectFormalizeMove(
  db: D1Database,
  problemId: string,
  cursor: number,
  source?: FormalizeMoveSource,
): Promise<FormalizeMoveResult> {
  const unavailable = { move: null, degraded: true } as const;
  try {
    if (
      !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}(?![\s\S])/.test(problemId) ||
      !Number.isSafeInteger(cursor) || cursor < 0
    ) return unavailable;
    let canonical = source;
    if (canonical === undefined) {
      const { loadReviewQueueAtCursor } = await import("../discovery/review-queue-service");
      canonical = { load: loadReviewQueueAtCursor, template: () => getMoveTemplate("formalize") };
    }
    const template = canonical.template();
    if (template.availability !== "available" || template.move !== "formalize") return unavailable;

    const items: ReviewQueueItem[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    let degraded = false;
    let scanned = 0;
    for (let page = 0; page < FORMALIZE_MAX_PAGES; page += 1) {
      const face = await canonical.load(db, problemId, cursor, after);
      if (
        face.problem !== problemId || !Array.isArray(face.candidates) ||
        !Number.isSafeInteger(face.scanned) || face.scanned < 0 ||
        face.scanned > REVIEW_QUEUE_PAGE_SIZE || face.candidates.length > face.scanned ||
        (face.next_after !== null) !== face.omitted.some((item) => item.reason === "page_limit")
      ) return unavailable;
      scanned += face.scanned;
      degraded ||= face.omitted.some((item) =>
        item.reason === "content_unavailable" || item.reason === "scope_budget_exceeded");
      for (const item of face.candidates) {
        // The production response schema validates all fields. These additional
        // cross-page/snapshot checks prevent selecting from inconsistent cuts.
        if (
          item.problem_id !== problemId || item.cursor !== cursor ||
          !/^C-[0-9]+(?![\s\S])/.test(item.claim_id) ||
          `${item.claim_id}@${item.version}`.length > 64 ||
          !Number.isSafeInteger(item.version) || item.version < 1 ||
          !Number.isSafeInteger(item.direct_dependents) || item.direct_dependents < 0 ||
          item.direct_dependents > 32 || typeof item.dependents_capped !== "boolean" ||
          !Number.isFinite(Date.parse(item.created_at)) ||
          new Date(item.created_at).toISOString() !== item.created_at ||
          seen.has(item.claim_id)
        ) return unavailable;
        seen.add(item.claim_id);
        items.push(item);
      }
      if (face.next_after === null) {
        after = undefined;
        break;
      }
      parseReviewQueueAfter(face.next_after);
      if (face.scanned === 0 || (after !== undefined && face.next_after <= after)) return unavailable;
      after = face.next_after;
    }

    const eligible = rankFormalizationTargets(items);
    const countsCapped = eligible.some((item) => item.dependents_capped);
    degraded ||= after !== undefined || countsCapped;
    if (eligible.length === 0) return { move: null, degraded };

    const assess = canonical.assess?.bind(canonical) ??
      (await import("../ledger/claim-dependency-snapshot.ts")).readClaimDependencySnapshot;
    let examined = 0;
    let unavailableGraphs = 0;
    let selected: { row: ReviewQueueItem; focus: FormalizationFocus } | undefined;
    for (const row of eligible.slice(0, FORMALIZE_MAX_ASSESSMENTS)) {
      examined++;
      const rootTarget = `${row.claim_id}@${row.version}`;
      try {
        const snapshot = await assess(db, problemId, cursor, rootTarget);
        const result = pickFormalizationFocus(snapshot, {
          problem: problemId, target: rootTarget, through: cursor, disposition: row.disposition,
        });
        if (result.kind === "selected") {
          selected = { row, focus: result.focus };
          break;
        }
        if (result.kind === "unavailable") { degraded = true; unavailableGraphs++; }
      } catch {
        // One unavailable graph need not suppress an independently readable
        // candidate, but the skipped higher priority remains disclosed.
        degraded = true; unavailableGraphs++;
      }
    }
    if (!selected) return { move: null, degraded: degraded || examined < eligible.length };

    const { row, focus } = selected;
    const target = focus.target;
    const [claimId, versionText] = target.split("@");
    const count = `${row.dependents_capped ? "at least " : ""}${row.direct_dependents}`;
    const read = (pin: string) => ({
      method: "GET" as const,
      path: `/p/${encodeURIComponent(problemId)}/claims/${pin}.md?through=${cursor}`,
    });
    const limitingTarget = focus.limitingPath.at(-1)!;
    return {
      degraded,
      move: {
        move: "formalize",
        why: `Formalize ${target} (${focus.standing.disposition}) on ${focus.priorityRoot}'s limiting publication path. ${focus.priorityRoot} was prioritized by ${count} verified direct dependency pins; this is its count, not an inherited count for the premise. Bounded selection is not a proof or a global optimum.`,
        refs: [problemId, target, ...(target === focus.priorityRoot ? [] : [focus.priorityRoot])],
        contract: {
          ...template,
          // A real attempt can reveal a false claim; never prefill supports.
          prefilled_hints: {
            bears_on_kind: "claim",
            bears_on_id: claimId,
            bears_on_version: Number(versionText),
            kind: "certificate",
            mode: "confirmatory",
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            target_claim: target,
            disposition: focus.standing.disposition,
            dependent_count: row.direct_dependents,
            dependent_count_target: focus.priorityRoot,
            dependents_capped: row.dependents_capped,
            counts_capped: countsCapped,
            admissions_examined: scanned,
            assessments_examined: examined,
            assessment_limit: FORMALIZE_MAX_ASSESSMENTS,
            unavailable_graphs: unavailableGraphs,
            selection_complete: !degraded,
            dependency_focus: {
              scope: "publication-pins",
              priority_root: focus.priorityRoot,
              dependency_path: [...focus.dependencyPath],
              limiting_path: [...focus.limitingPath],
              own_evidence_class: focus.standing.own_ceiling,
              review_state: focus.standing.review_state,
              target_chain: focus.chain,
              priority_chain: focus.priorityChain,
            },
            read_first: read(target),
            ...(target === focus.priorityRoot ? {} : { read_prioritized_claim: read(focus.priorityRoot) }),
            ...(target === limitingTarget ? {} : { read_limiting_premise: read(limitingTarget) }),
            ...(after === undefined ? {} : {
              continue_discovery: {
                method: "GET",
                path: `/reviews.json?${new URLSearchParams({ problem: problemId, after })}`,
                note: "This public discovery continuation reads live state, not the recommendation's frozen scientific cut.",
              },
            }),
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "prove" },
            },
            note: "Read the exact statement, limiting premises, evidence and counterevidence first. The chosen premise has its own corroborated/disputed standing; its parent's reviews are not inherited. Unreviewed premises on the remaining path still need independent review. Check matching scope, assumptions and quantifiers; do not relabel a weaker theorem. Run tools in your sponsor's harness and supply the actual formal_artifact, source, direction and body_md. Retain unfinished work privately or publish the actual result, including failure or counterevidence, through the ordinary validator. The recommendation neither reserves work nor grants publication authority; independent review determines scientific standing.",
          },
        },
        selection_boundary: FORMALIZE_MOVES_BOUNDARY,
      },
    };
  } catch {
    return unavailable;
  }
}
