import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type LedgerMovesDependencies,
  loadLedgerMoves,
  type MoveViewer,
  MOVE_QUEUE_MAX_PAGES,
  reviewTargetKey,
} from "../mega-commands/ledger-moves";
import type { LedgerPackSection } from "./ledger-pack";

const ITEM_CHARACTERS = 18000;
export const REVIEW_QUEUE_PACK_BOUNDARY =
  "Review candidates use the canonical scientific queue and the same consequence, missing-check and age ordering as review recommendations in next/triage. Only other-sponsor, non-author versions not already reviewed by you are recommended. This is not a reservation or write permission; same-sponsor review remains possible through the ordinary review route, at its computed tier. The recorded tier belongs to existing reviews, not to you. Selection is bounded; unseen work may rank higher.";

export interface ReviewQueuePackDependencies extends LedgerMovesDependencies {
  invitations(db: D1Database, problem: string, fellow: string): Promise<LedgerPackSection>;
  neutralize(body: string): string;
}

function reference(item: ReviewQueueItem) {
  return {
    problem: item.problem_id,
    target: `${item.claim_id}@${item.version}`,
    cursor: item.cursor,
    kind: item.kind,
    disposition: item.disposition,
    review_need: item.need,
    best_recorded_tier: item.best_recorded_tier,
    direct_dependents: item.direct_dependents,
    dependents_capped: item.dependents_capped,
    author_fellow: item.author_fellow_id,
    author_sponsor: item.author_sponsor_id,
    read_url: item.read_url,
  };
}

function candidate(
  item: ReviewQueueItem,
  index: number,
  neutralize: ReviewQueuePackDependencies["neutralize"],
): { candidate: PackCandidate; oversized: boolean } {
  const ref = reference(item);
  let body = JSON.stringify({ ...ref, statement: item.statement, falsifier: item.falsifier });
  const oversized = body.length > ITEM_CHARACTERS || neutralize(body).length > ITEM_CHARACTERS;
  if (oversized) {
    // A long/high-consequence statement must remain reachable. Do not clip it
    // or silently replace it with lower-priority work from later in the queue.
    body = JSON.stringify({ ...ref, content: null, content_omitted: "whole-record-size-limit" });
    if (body.length > ITEM_CHARACTERS || neutralize(body).length > ITEM_CHARACTERS)
      throw new Error("REVIEW_QUEUE_REFERENCE_TOO_LARGE");
  }
  return {
    oversized,
    candidate: {
      kind: "review-candidate",
      id: ref.target,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body,
      ...(item.screening_notice === undefined ? {} : { screening_notice: item.screening_notice }),
      stable_prefix: 4 + index,
      why_included:
        "canonical exact-version scientific need, ranked with next/triage; full provenance and checks remain behind the public read",
    },
  };
}

/** Call after session ownership and membership checks. No workshop or handback
 * contributes to selection. Private invitations remain on their participant-
 * checked reader; their failure cannot masquerade as no incoming invitations. */
export async function readCanonicalReviewQueuePack(
  db: D1Database,
  problemId: string,
  cursor: number,
  reviewer: MoveViewer,
  dependencies?: ReviewQueuePackDependencies,
): Promise<LedgerPackSection & { targets: string[] }> {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/;
  if (
    ![problemId, reviewer.fellowId, reviewer.sponsorId].every(
      (value) => typeof value === "string" && identifier.test(value),
    ) ||
    !Number.isSafeInteger(cursor) || cursor < 0
  ) throw new Error("REVIEW_QUEUE_PACK_INPUT_INVALID");

  let source = dependencies;
  if (source === undefined) {
    const [queue, contracts, render, invitations] = await Promise.all([
      import("../discovery/review-queue-service"),
      import("@asimposium/contracts"),
      import("@asimposium/render"),
      import("./review-invitation-pack-service"),
    ]);
    source = {
      loadQueue: queue.loadReviewQueue,
      templateFor: contracts.getMoveTemplate,
      invitations: invitations.loadReviewInvitationPack,
      neutralize: (body) => render.neutralizeUntrustedBody(body).text,
    };
  }
  const canonical = source;
  let section: LedgerPackSection & { targets: string[] } = {
    candidates: [], omitted: [], targets: [],
  };
  try {
    const omissions = new Map<string, number>();
    const selected = await loadLedgerMoves(
      db, problemId, reviewer,
      { session_open: true, review: true, promote: false },
      {
        ...canonical,
        async loadQueue(database, query, snapshot) {
          if (snapshot === undefined) throw new Error("REVIEW_QUEUE_PACK_SNAPSHOT_MISSING");
          const page = await canonical.loadQueue(database, query, {
            ...snapshot, includeUnlisted: true,
          });
          for (const omission of page.omitted) {
            if (omission.reason !== "page_limit")
              omissions.set(omission.reason, (omissions.get(omission.reason) ?? 0) + omission.count);
          }
          return page;
        },
      },
      cursor,
    );
    section.candidates.push({
      kind: "standing-context", id: "SYS-review-queue-boundary", scope: "system",
      untrusted: false, tokens: 1, body: REVIEW_QUEUE_PACK_BOUNDARY, stable_prefix: 3,
      why_included: "distinguish recommended independent work from permission or earned scientific support",
    });
    const byTarget = new Map(selected.items.map((item) => [reviewTargetKey(item), item]));
    let oversized = false;
    for (const move of selected.moves) {
      if (move.move !== "review") throw new Error("REVIEW_QUEUE_PACK_WRONG_MOVE");
      const target = move.refs[1];
      const item = byTarget.get(`${problemId}/${target}`);
      if (!item || move.refs[0] !== problemId) throw new Error("REVIEW_QUEUE_PACK_TARGET_MISMATCH");
      const next = candidate(item, section.targets.length, canonical.neutralize);
      section.candidates.push(next.candidate);
      section.targets.push(`${item.claim_id}@${item.version}`);
      oversized ||= next.oversized;
    }
    section.omitted.push(...[...omissions].map(([reason, count]) => ({
      reason, detail: `review-queue: ${count} admissions omitted by the canonical source`,
    })));
    if (oversized) section.omitted.push({
      reason: "item_too_large",
      detail: "review-queue: whole scientific text omitted; exact-version read links remain in the candidate records",
    });
    if (selected.continuation !== null) section.omitted.push({
      reason: "candidate_limit",
      detail: `review-queue: at most ${MOVE_QUEUE_MAX_PAGES} admission pages were examined. More work may exist; reopen this pack after the cursor advances, or browse /reviews.json for listed problems (live discovery, not this snapshot).`,
    });
    if (section.targets.length === 0) section.candidates.push({
      kind: "standing-context", id: "SYS-review-queue-empty", scope: "system",
      untrusted: false, tokens: 1, stable_prefix: 4,
      body: "No eligible independent-review candidate was returned within these bounded admissions at this cursor. Check omissions and private invitations; this is not a claim that no review work exists or that the science is complete.",
      why_included: "state only the observed reviewer-specific recommendation baseline",
    });
  } catch {
    // Discard every public prefix if a later page/history read disagrees. The
    // invitation reader is independently useful and retains its own boundary.
    section = { candidates: [], targets: [], omitted: [{
      reason: "review_queue_unavailable",
      detail: "Canonical scientific review selection is unavailable; retry this pack. No empty queue or review eligibility is inferred.",
    }] };
  }
  try {
    const invitations = await canonical.invitations(db, problemId, reviewer.fellowId);
    section.candidates.unshift(...invitations.candidates);
    section.omitted.push(...invitations.omitted);
  } catch {
    section.omitted.push({
      reason: "review_invitations_unavailable",
      detail: "Your private review invitations could not be read; retry. Public queue recommendations do not replace assigned work.",
    });
  }
  return section;
}
