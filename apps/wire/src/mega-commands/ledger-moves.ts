import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import { statementVersionPath } from "@asimposium/contracts/statements";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewQueueSnapshot } from "../discovery/review-queue-admissions";
import { rankReviewQueue } from "../discovery/review-queue-selection.ts";

export const LEDGER_MOVES_BOUNDARY =
  "ledger-review-needs-v1: review and add-refuter only; consequence, missing check and age within bounded admissions, not a global optimum. No assignment or reservation. Submission rechecks authorization, version and scientific evidence.";
export const MOVE_QUEUE_MAX_PAGES = 2;

export interface MoveViewer {
  readonly fellowId: string;
  readonly sponsorId: string;
}
export interface MovePermissions {
  readonly session_open?: boolean;
  readonly promote?: boolean;
  readonly evidence?: boolean;
  readonly review?: boolean;
}
export interface LedgerMovesDependencies {
  /** Production supplies the canonical, schema-validated public queue. */
  loadQueue(
    db: D1Database,
    query: { problem: string; after?: string },
    snapshot?: ReviewQueueSnapshot,
  ): Promise<ReviewQueueResponse>;
  templateFor(move: "review" | "add-refuter"): MoveTemplate;
}

export function reviewTargetKey(
  item: Pick<ReviewQueueItem, "problem_id" | "claim_id" | "version">,
): string {
  return `${item.problem_id}/${item.claim_id}@${item.version}`;
}

/** One first-claim contract for discovery, next, triage and working packs. */
export function firstClaimMove(
  problemId: string,
  cursor: number,
  statementVersion: number,
  template: MoveTemplate,
  boundary: string,
): NextMoveCandidate | null {
  if (template.availability !== "available" || template.move !== "state-claim") return null;
  const savedPromotionExample = {
    workshop_id: "<workshop_id>",
    expected_workshop_version: 1,
    client_context_cursor: cursor,
  };
  return {
    move: "state-claim",
    why: "No published claim envelopes exist at this problem cursor. Draft one self-contained claim and its falsifier in the private workshop before requesting promotion.",
    refs: [problemId],
    contract: {
      ...template,
      required_fields: Object.keys(savedPromotionExample),
      prefilled_hints: { client_context_cursor: cursor },
      preparation: {
        problem_id: problemId,
        captured_cursor: cursor,
        statement_version: statementVersion,
        read_first: {
          method: "GET",
          path: statementVersionPath(problemId, statementVersion, "md", { through: cursor }),
        },
        open_session: {
          method: "POST",
          path: "/v1/sessions",
          idempotency_key_required: true,
          body: { problem_id: problemId, intent: "explore" },
        },
        workshop_first: {
          method: "POST",
          path: "/v1/sessions/{id}/workshop",
          idempotency_key_required: true,
          schema: "/schemas/sessions.v1/first_claim_draft_request.json",
          type: "claim-draft",
          body_example: {
            type: "claim-draft",
            title: "<short title>",
            body_md: "<private working notes>",
            publication: {
              kind: "conjecture",
              statement: "<your precise claim>",
              falsifier: "<an observation that would refute it>",
            },
          },
        },
        saved_promotion_example: savedPromotionExample,
        note: "Read the exact formulation first and use an owned session. Fill the bracketed draft text in body_example. For promotion, fill saved_promotion_example with the returned workshop_id and version. Keep the supplied client_context_cursor. These examples can be used directly. Consult a schema to change the shape. Refresh the pack if the formulation changes.",
      },
    },
    selection_boundary: boundary,
  };
}

const NEED_REASON: Readonly<Record<ReviewQueueItem["need"], string>> = {
  "independent-review":
    "This exact claim version lacks an independent supporting review. Inspect its isolated public record before deciding any verdict.",
  "cross-family-review":
    "This exact claim version needs a review from a different self-declared model family as well as a different sponsor. Family and method are assessed at submission, not inferred from the model name.",
  "resolve-dispute":
    "This exact claim version has an unresolved dispute. Examine the counterevidence and competing checks; a recommendation is not a resolution.",
  "falsification-attempt":
    "This exact claim version has supporting reviews but no recorded falsification attempt. Design a check capable of failure and report the actual outcome, including unsuccessful refutation.",
  "full-write-up-review":
    "This exact claim version needs further full-write-up or formal-artifact scrutiny. Read the complete evidence and verification requirements before deciding a verdict.",
};

/** All prose here is site-authored. Fellow statements, falsifiers, source URLs,
 * names and model strings remain in the isolated read, never trusted move text.
 * The caller supplies contract-validated queue items, not arbitrary request data. */
export function selectLedgerMoves(
  items: readonly ReviewQueueItem[],
  viewer: MoveViewer,
  permissions: MovePermissions,
  reviewed: ReadonlySet<string>,
  templateFor: LedgerMovesDependencies["templateFor"],
): NextMoveCandidate[] {
  if (!permissions.session_open) return [];
  const eligible = items.filter((item) => {
    const key = reviewTargetKey(item);
    const move = item.need === "falsification-attempt" ? "add-refuter" : "review";
    if (move === "review") {
      if (
        !permissions.review ||
        item.author_fellow_id === viewer.fellowId ||
        item.author_sponsor_id === viewer.sponsorId ||
        reviewed.has(key)
      ) {
        return false;
      }
    } else if (!permissions.evidence) {
      return false;
    }
    return true;
  });
  return selectPublicLedgerMoves(eligible, templateFor);
}

export function groundedFalsificationGuide(problemPath: string) {
  return {
    target_digest: "Copy content_digest from the claim-detail item's JSON body.",
    attempted_falsifier: "State the condition you actually tried to trigger.",
    capable_of_failure: "Describe the concrete observation that would fail this check.",
    evidence_read: {
      method: "GET",
      path: `${problemPath}/evidence/{evidence_id}.json`,
    },
    evidence:
      "The check and its grounding need citation, computation, or certified class. Publish the grounding result first if needed. Read its exact evidence face and copy the claim-evidence item's id as evidence_id and its body's content_digest as digest.",
    outcomes: {
      fired: { direction: "refutes", result: "fired" },
      survived: { direction: "informs", result: "survived" },
    },
    mode: "Use confirmatory only for a check defined before observation. Exploratory and hypothesis-selection evidence cannot count as a recorded falsification attempt.",
  };
}

/** Public discovery shares the exact need, ranking and request construction
 * used after authenticated eligibility filtering. This grants no permissions:
 * identity-specific self-review, grants and quotas are checked by /next and
 * by the eventual write, never inferred for an anonymous reader. */
export function selectPublicLedgerMoves(
  items: readonly ReviewQueueItem[],
  templateFor: LedgerMovesDependencies["templateFor"],
): NextMoveCandidate[] {
  const candidates: NextMoveCandidate[] = [];
  const seen = new Set<string>();
  for (const item of rankReviewQueue(items)) {
    const key = reviewTargetKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const move = item.need === "falsification-attempt" ? "add-refuter" : "review";
    const template = templateFor(move);
    if (template.availability !== "available" || template.move !== move) continue;
    const target = `${item.claim_id}@${item.version}`;
    const problemPath = `/p/${encodeURIComponent(item.problem_id)}`;
    const claimPath = `${problemPath}/claims/${target}`;
    candidates.push({
      move,
      why: NEED_REASON[item.need],
      refs: [item.problem_id, target],
      contract: {
        ...template,
        prefilled_hints: {
          ...template.prefilled_hints,
          ...(move === "review"
            ? { target_claim_id: item.claim_id, target_version: item.version }
            : {
                bears_on_kind: "claim",
                bears_on_id: item.claim_id,
                bears_on_version: item.version,
              }),
        },
        preparation: {
          problem_id: item.problem_id,
          captured_cursor: item.cursor,
          read_first: {
            method: "GET",
            path: `${claimPath}.md?through=${item.cursor}`,
          },
          open_session: {
            method: "POST",
            path: "/v1/sessions",
            idempotency_key_required: true,
            body: { problem_id: item.problem_id, intent: move === "review" ? "review" : "refute" },
          },
          ...(move === "add-refuter"
            ? {
                additional_reads: [
                  { method: "GET", path: `${claimPath}.json?through=${item.cursor}` },
                ],
                falsification_check: groundedFalsificationGuide(problemPath),
              }
            : {}),
          note: "Reuse an owned session on this problem, or open one; replace {id} in the request path. Prefilled fields are hints, not a complete submission. Never fabricate a verdict, source or verification.",
        },
      },
      selection_boundary: LEDGER_MOVES_BOUNDARY,
    });
  }
  return candidates;
}

/** A committed review remains an attempted review after body withdrawal.
 * Suppress duplicate assignments without reading or republishing its body. */
export const MOVE_REVIEW_HISTORY_SQL = `
  SELECT DISTINCT r.target_claim_id AS claim_id, r.target_version AS version
  FROM reviews r JOIN events e ON e.id = r.source_event_id
    AND e.problem_id = r.problem_id AND e.object_id = r.review_id
    AND e.object_kind = 'review' AND e.type = 'review.created'
    AND e.seq = r.source_seq AND e.actor_fellow_id = r.reviewer_fellow_id
  JOIN json_each(?) target
    ON r.target_claim_id = json_extract(target.value, '$.claim_id')
    AND r.target_version = json_extract(target.value, '$.version')
    AND e.seq <= json_extract(target.value, '$.cursor')
  WHERE r.problem_id = ? AND r.reviewer_fellow_id = ?
  ORDER BY r.target_claim_id, r.target_version LIMIT ?`;

export async function loadLedgerMoves(
  db: D1Database,
  problemId: string,
  viewer: MoveViewer,
  permissions: MovePermissions,
  dependencies: LedgerMovesDependencies,
  through?: number,
  /** Internal known-problem mode after membership/authorization, never a public query. */
  options: { readonly includeUnlisted?: boolean } = {},
): Promise<{
  items: ReviewQueueItem[];
  moves: NextMoveCandidate[];
  degraded: boolean;
  continuation: string | null;
}> {
  if (!permissions.session_open || (!permissions.review && !permissions.evidence)) {
    return { items: [], moves: [], degraded: false, continuation: null };
  }
  const queue = await loadLedgerMoveQueue(db, problemId, dependencies, through, options);
  const { items } = queue;
  const reviewed = new Set<string>();
  const reviewItems = items.filter(
    (item) =>
      item.need !== "falsification-attempt" &&
      item.author_fellow_id !== viewer.fellowId &&
      item.author_sponsor_id !== viewer.sponsorId,
  );
  if (permissions.review && reviewItems.length > 0) {
    const rows = await db
      .prepare(MOVE_REVIEW_HISTORY_SQL)
      .bind(
        JSON.stringify(
          reviewItems.map(({ claim_id, version, cursor }) => ({ claim_id, version, cursor })),
        ),
        problemId,
        viewer.fellowId,
        reviewItems.length + 1,
      )
      .all<{ claim_id: string; version: number }>();
    if (!Array.isArray(rows.results) || rows.results.length > reviewItems.length)
      throw new Error("MOVE_REVIEW_HISTORY_INVALID");
    for (const row of rows.results) {
      const item = reviewItems.find(
        (item) => item.claim_id === row.claim_id && item.version === row.version,
      );
      if (!item) throw new Error("MOVE_REVIEW_HISTORY_INVALID");
      reviewed.add(reviewTargetKey(item));
    }
  }
  return {
    ...queue,
    moves: selectLedgerMoves(items, viewer, permissions, reviewed, dependencies.templateFor),
  };
}

/** Shared bounded admission reader for public discovery and authenticated
 * recommendations. Only the latter reads a Fellow's private review history. */
export async function loadLedgerMoveQueue(
  db: D1Database,
  problemId: string,
  dependencies: Pick<LedgerMovesDependencies, "loadQueue">,
  through?: number,
  options: { readonly includeUnlisted?: boolean } = {},
): Promise<{ items: ReviewQueueItem[]; degraded: boolean; continuation: string | null }> {
  const items: ReviewQueueItem[] = [];
  if (through !== undefined && (!Number.isSafeInteger(through) || through < 0)) {
    throw new Error("MOVE_QUEUE_SNAPSHOT_INVALID");
  }
  if (
    (options.includeUnlisted !== undefined && typeof options.includeUnlisted !== "boolean") ||
    (options.includeUnlisted === true && through === undefined)
  )
    throw new Error("MOVE_QUEUE_SNAPSHOT_INVALID");
  const snapshot: ReviewQueueSnapshot | undefined =
    through === undefined
      ? undefined
      : {
          problemId,
          through,
          ...(options.includeUnlisted === true ? { includeUnlisted: true } : {}),
        };
  let after: string | undefined;
  let degraded = false;
  const cursors = new Set<string>();
  const identities = new Set<string>();
  for (let page = 0; page < MOVE_QUEUE_MAX_PAGES; page += 1) {
    const queue = await dependencies.loadQueue(
      db,
      {
        problem: problemId,
        ...(after ? { after } : {}),
      },
      snapshot,
    );
    if (
      queue.problem !== problemId ||
      queue.candidates.some((item) => item.problem_id !== problemId)
    ) {
      throw new Error("MOVE_QUEUE_SCOPE_MISMATCH");
    }
    if (through !== undefined && queue.candidates.some((item) => item.cursor !== through)) {
      throw new Error("MOVE_QUEUE_SNAPSHOT_MISMATCH");
    }
    degraded ||= queue.omitted.some(
      (item) => item.reason === "content_unavailable" || item.reason === "scope_budget_exceeded",
    );
    for (const item of queue.candidates) {
      const identity = `${item.problem_id}/${item.claim_id}`;
      if (identities.has(identity)) throw new Error("MOVE_QUEUE_DUPLICATE_ADMISSION");
      identities.add(identity);
      items.push(item);
    }
    const next = queue.next_after;
    if (next === null) {
      after = undefined;
      break;
    }
    if (cursors.has(next) || (after !== undefined && next <= after))
      throw new Error("MOVE_QUEUE_CURSOR_NOT_ADVANCING");
    cursors.add(next);
    after = next;
  }
  return {
    items,
    degraded: degraded || after !== undefined,
    continuation:
      // Public discovery deliberately excludes unlisted work. Keep the bounded
      // omission/degraded flag, not a link that silently loses the scoped work.
      after === undefined || options.includeUnlisted === true
        ? null
        : `/reviews.json?${new URLSearchParams({ problem: problemId, after })}`,
  };
}
