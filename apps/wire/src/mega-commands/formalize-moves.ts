import { getMoveTemplate, type MoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import {
  parseReviewQueueAfter,
  REVIEW_QUEUE_PAGE_SIZE,
  type ReviewQueueItem,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";

export const FORMALIZE_MAX_PAGES = 2;
export const FORMALIZE_MOVES_BOUNDARY =
  "formalization-needs-v2: rank corroborated or disputed exact claim versions by verified direct dependency pins within at most two canonical admission pages. Counts can be capped; this is not a whole-graph optimum or a proof of any implication. A formal artifact earns no scientific standing until the ordinary independent checks accept it.";

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
    // Capping any eligible count makes the relative ranking approximate, even
    // when the chosen row happens to have an uncapped count.
    const countsCapped = eligible.some((item) => item.dependents_capped);
    degraded ||= after !== undefined || countsCapped;
    const row = eligible[0];
    if (!row) return { move: null, degraded };

    const target = `${row.claim_id}@${row.version}`;
    const count = `${row.dependents_capped ? "at least " : ""}${row.direct_dependents}`;
    return {
      degraded,
      move: {
        move: "formalize",
        why: `Prioritize ${target}: ${count} verified direct dependency pins and a ${row.disposition} standing at this cursor. Selection uses bounded verified counts in the examined admissions; capped counts can leave relative priority uncertain. This is not a proven foundation or a global optimum.`,
        refs: [problemId, target],
        contract: {
          ...template,
          // Do not prefill direction=supports: a genuine formalization attempt
          // can reveal a false statement, a weaker theorem or a proof gap.
          prefilled_hints: {
            bears_on_kind: "claim",
            bears_on_id: row.claim_id,
            bears_on_version: row.version,
            kind: "certificate",
            mode: "confirmatory",
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            target_claim: target,
            disposition: row.disposition,
            dependent_count: row.direct_dependents,
            dependents_capped: row.dependents_capped,
            counts_capped: countsCapped,
            admissions_examined: scanned,
            selection_complete: !degraded,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/claims/${target}.md?through=${cursor}`,
            },
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
            note: "Read the exact statement, premises, evidence and counterevidence first. Check that the theorem you formalize has the same scope, assumptions and quantifiers. Run tools in your sponsor's harness and supply the actual formal_artifact, source, direction and body_md. Do not relabel a weaker theorem as this claim. A failed attempt or counterexample is useful; retain unfinished work privately or publish the actual result through the appropriate ordinary validator. Independent review, not this recommendation or an author-supplied certificate, determines scientific standing.",
          },
        },
        selection_boundary: FORMALIZE_MOVES_BOUNDARY,
      },
    };
  } catch {
    // Missing canonical inputs never fall back to raw projections or a fake
    // empty queue. The caller may still offer its other independently read work.
    return unavailable;
  }
}
