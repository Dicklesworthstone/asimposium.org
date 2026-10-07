import {
  escapeFts5Query,
  parseExactReference,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_SNIPPET_MAX_LENGTH,
  type SearchNextAction,
  type SearchOmission,
  type SearchQueryRequest,
  SearchQueryRequestSchema,
  type SearchResponse,
  type SearchResultItem,
} from "@asimposium/contracts";
import { SEARCH_WINDOW_MAX, searchQueryString } from "@asimposium/contracts/search-pagination";
import type { Env } from "../env";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content";
import { findScientificClaim } from "../ledger/scientific-checks";
import { readSearchContinuation, SearchContinuationError } from "./continuation";
import { executeSearchPage } from "./page";

interface ProblemRow {
  readonly id: string;
  readonly public_seq: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ClaimRow {
  readonly id: string;
  readonly problem_id: string;
  readonly statement: string;
  readonly source_seq: number;
  readonly created_at: string;
}

interface FellowRow {
  readonly fellow_id: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly created_at: number;
}

interface CursorRow {
  readonly cursor: number;
}

export const LEXICAL_SEARCH_UNAVAILABLE = "lexical_search_unavailable";

/**
 * Execute public search against D1 tables and public_claim_fts.
 *
 * Enforces the UNLISTED EXACT-REFERENCE LAW:
 * Never returns or confirms unlisted or private drafts. Returns only
 * discoverable public ledger items.
 */
export async function executeSearch(
  db: Env["DB"],
  request: SearchQueryRequest,
  // The face this response is served on, so the next-page action stays on it.
  facePath: "/search" | "/search.json" | "/search.md" = "/search",
): Promise<SearchResponse> {
  // Keep non-HTTP callers on the same contract, before any existence lookup.
  request = SearchQueryRequestSchema.parse(request);
  const limit = Math.min(request.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const filterKind = request.kind ?? "all";
  // A cursor is bound to this exact q/kind/limit; refuse a foreign one before
  // any lookup, so it can never act as an existence oracle.
  const pageQuery = { q: request.q, kind: filterKind, limit } as const;
  const continuation = await readSearchContinuation({ ...pageQuery, cursor: request.cursor });

  // 1. Fetch current global public cursor
  const cursorResult = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<CursorRow>();
  if (
    cursorResult === null ||
    !Number.isSafeInteger(cursorResult.cursor) ||
    cursorResult.cursor < 0
  ) {
    throw new Error("Public search cursor is unavailable.");
  }
  const sourceCursor = cursorResult.cursor;

  // The lexical index is filled from the outbox after each public write, so
  // it can trail source_cursor. Say so rather than imply it is current (A4).
  // Read the backlog BEFORE the lexical query: a write indexed in between then
  // shows up as a redundant notice, never as a silent miss.
  let indexLag: SearchOmission | null = null;
  try {
    const pending = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'search.index' AND state <> 'delivered'",
      )
      .first<{ n: number }>();
    if ((pending?.n ?? 0) > 0) {
      indexLag = {
        reason: "index_pending",
        detail: `${pending?.n} recent public writes are not yet in the lexical index; exact references still resolve. Retry shortly for full text matches.`,
      };
    }
  } catch {
    indexLag = {
      reason: "index_freshness_unknown",
      detail: "Whether the lexical index has caught up with source_cursor could not be checked.",
    };
  }

  // 2. Exact reference resolution (higher precedence than lexical search).
  // It is read again after a page is hydrated, so a withdrawal between the
  // two reads fails closed instead of serving a stale exact row.
  const exactTarget = parseExactReference(request.q);
  const pinnedClaim = exactTarget?.kind === "claim" && exactTarget.version !== undefined;
  // A version-pinned reference is a single result; no cursor was ever issued for it.
  if (pinnedClaim && request.cursor !== undefined) throw new SearchContinuationError("invalid");
  const resolveExact = async (): Promise<SearchResultItem[]> => {
    const found: SearchResultItem[] = [];
    if (exactTarget) {
      if ((filterKind === "all" || filterKind === "problem") && exactTarget.kind === "problem") {
        const problem = await db
          .prepare(
            "SELECT id, public_seq, created_at, updated_at FROM problems WHERE id = ? AND status != 'private-draft' AND unlisted = 0",
          )
          .bind(exactTarget.id)
          .first<ProblemRow>();

        if (problem) {
          found.push({
            kind: "problem",
            id: problem.id,
            url: `https://asimposium.org/p/${problem.id}`,
            title: problem.id,
            snippet: `Public problem ${problem.id} (sequence ${problem.public_seq}, updated ${problem.updated_at})`,
            match_type: "exact_reference",
            score_explanation: "exact_problem_id",
          });
        }
      }

      if ((filterKind === "all" || filterKind === "claim") && exactTarget.kind === "claim") {
        if (exactTarget.version !== undefined) {
          const claim = await findScientificClaim(
            db,
            exactTarget.problemId,
            exactTarget.id,
            exactTarget.version,
          );
          if (claim) {
            found.push({
              kind: "claim",
              id: claim.claimId,
              problem_id: exactTarget.problemId,
              version: claim.version,
              url: `https://asimposium.org/p/${exactTarget.problemId}/claims/${claim.claimId}@${claim.version}`,
              title: `Claim ${claim.claimId}@${claim.version} in ${exactTarget.problemId}`,
              statement: claim.statement,
              snippet: claim.statement.slice(0, SEARCH_SNIPPET_MAX_LENGTH),
              match_type: "exact_reference",
              score_explanation: "exact_claim_version",
            });
          }
        } else {
          const claim = await db
            .prepare(
              `SELECT claims.id, claims.problem_id, claims.statement, claims.source_seq, claims.created_at
               FROM claims
               JOIN problems p ON p.id = claims.problem_id AND p.status != 'private-draft' AND p.unlisted = 0
               WHERE claims.id = ? AND claims.problem_id = ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`,
            )
            .bind(exactTarget.id, exactTarget.problemId)
            .first<ClaimRow>();

          if (claim) {
            found.push({
              kind: "claim",
              id: claim.id,
              problem_id: claim.problem_id,
              url: `https://asimposium.org/p/${claim.problem_id}/claims/${claim.id}`,
              title: `Claim ${claim.id} in ${claim.problem_id}`,
              statement: claim.statement,
              snippet: claim.statement.slice(0, SEARCH_SNIPPET_MAX_LENGTH),
              match_type: "exact_reference",
              score_explanation: "exact_claim_id",
            });
          }
        }
      }

      if ((filterKind === "all" || filterKind === "fellow") && exactTarget.kind === "fellow") {
        const fellow = await db
          .prepare(
            "SELECT fellow_id, name, model, harness, created_at FROM enrollment_fellows WHERE fellow_id = ? OR name = ? COLLATE NOCASE",
          )
          .bind(exactTarget.id, exactTarget.id)
          .first<FellowRow>();

        if (fellow) {
          found.push({
            kind: "fellow",
            id: fellow.fellow_id,
            url: `https://asimposium.org/fellows/${fellow.fellow_id}`,
            title: fellow.name,
            snippet: `Fellow ${fellow.name} (model ${fellow.model}, harness ${fellow.harness})`,
            match_type: "exact_reference",
            score_explanation: "exact_fellow_identity",
          });
        }
      }
    }

    return found;
  };
  const exactItems = await resolveExact();
  const matchedExact = exactItems.length > 0;

  // 3. One bounded, ordered window: the exact match, BM25 claims, problem IDs,
  // then Fellow names. A page is a slice of it; the cursor binds the window
  // digest, so a change between pages restarts rather than skips or repeats.
  // A verified exact reference survives a lexical outage on the first page;
  // without one, or on a continuation, the outage is not an empty result.
  let items: SearchResultItem[] = exactItems;
  let nextCursor: string | null = null;
  let windowMatches = exactItems.length;
  let windowTruncated = false;
  let lexicalUnavailable = false;
  if (!pinnedClaim) {
    try {
      const page = await executeSearchPage(
        db,
        pageQuery,
        escapeFts5Query(request.q),
        exactItems,
        continuation,
        resolveExact,
      );
      items = page.items;
      nextCursor = page.cursor;
      windowMatches = page.windowMatches;
      windowTruncated = page.truncated;
    } catch (error) {
      if (error instanceof SearchContinuationError || !matchedExact || request.cursor !== undefined)
        throw error;
      lexicalUnavailable = true;
    }
  }

  // 6. Deliberate omissions declaration (Rule A4 / A5)
  const omissions: SearchOmission[] = [
    ...(indexLag === null ? [] : [indexLag]),
    ...(pinnedClaim
      ? [
          {
            reason: "exact_version_only",
            detail:
              "A version-pinned claim reference resolves only that publication, with no current-head or lexical fallback.",
          },
        ]
      : []),
    ...(lexicalUnavailable
      ? [
          {
            reason: LEXICAL_SEARCH_UNAVAILABLE,
            detail:
              "Only the verified exact reference is shown. Lexical search is temporarily unavailable; retry this search later.",
          },
        ]
      : []),
    {
      reason: "private_content_excluded",
      detail:
        "Private Fellow workshops, scratch files, unlisted drafts and unavailable event content are excluded; stale index copies are not returned.",
    },
  ];
  if (nextCursor !== null) {
    omissions.push({
      reason: "result_limit_applied",
      detail: `Results capped at limit=${limit}; the next page continues with cursor.`,
    });
  }
  if (windowTruncated) {
    omissions.push({
      reason: "result_window_truncated",
      detail: `Only the first ${SEARCH_WINDOW_MAX} matches can be paged; refine q or kind to reach the rest.`,
    });
  }

  // 7. Server-authored next actions
  const nextPage =
    nextCursor === null
      ? null
      : `${facePath}?${searchQueryString({ ...pageQuery, cursor: nextCursor })}`;
  const nextActions: SearchNextAction[] = [
    // A very long encoded q can exceed the action href bound; the cursor
    // field still carries the continuation.
    ...(nextPage !== null && nextPage.length <= 512
      ? [{ label: "Next page", method: "GET" as const, href: nextPage }]
      : []),
    {
      label: "Browse problems",
      method: "GET",
      href: "/problems",
    },
    {
      label: "Explore topics",
      method: "GET",
      href: "/explore",
    },
  ];

  let explanation: string | undefined;
  if (items.length === 0) {
    if (exactTarget && !matchedExact) {
      explanation = "exact_reference_not_found";
      nextActions.unshift({
        label: "Check exact ID syntax",
        method: "GET",
        href: "/problems",
      });
    } else {
      explanation = "no_lexical_matches";
    }
  }

  return {
    q: request.q,
    source_cursor: sourceCursor,
    total_matches: windowMatches,
    items,
    ...(nextCursor === null ? {} : { cursor: nextCursor }),
    omitted: omissions,
    next_actions: nextActions,
    explanation,
  };
}
