import {
  escapeFts5Query,
  parseExactReference,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type SearchNextAction,
  type SearchOmission,
  type SearchQueryRequest,
  type SearchResponse,
  type SearchResultItem,
} from "@asimposium/contracts";
import type { Env } from "../env";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content";

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

interface FtsClaimRow {
  readonly claim_id: string;
  readonly problem_id: string;
  readonly statement: string;
  readonly snippet: string | null;
  readonly rank: number;
}

interface CursorRow {
  readonly cursor: number;
}

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
): Promise<SearchResponse> {
  const limit = Math.min(request.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const filterKind = request.kind ?? "all";

  // 1. Fetch current global public cursor
  let sourceCursor = 0;
  try {
    const cursorResult = await db
      .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
      .first<CursorRow>();
    if (cursorResult && typeof cursorResult.cursor === "number") {
      sourceCursor = cursorResult.cursor;
    }
  } catch {
    // If public_cursor table is missing or unseeded, default to 0
  }

  const items: SearchResultItem[] = [];
  const seenKeys = new Set<string>();

  const addItem = (item: SearchResultItem) => {
    const key = `${item.kind}:${item.id}:${item.problem_id ?? ""}`;
    if (!seenKeys.has(key) && items.length < limit) {
      seenKeys.add(key);
      items.push(item);
    }
  };

  // 2. Exact reference resolution (higher precedence than lexical search)
  const exactTarget = parseExactReference(request.q);
  let matchedExact = false;

  if (exactTarget) {
    if ((filterKind === "all" || filterKind === "problem") && exactTarget.kind === "problem") {
      const problem = await db
        .prepare("SELECT id, public_seq, created_at, updated_at FROM problems WHERE id = ?")
        .bind(exactTarget.id)
        .first<ProblemRow>();

      if (problem) {
        matchedExact = true;
        addItem({
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
      // Look up claim in claims table
      let claim: ClaimRow | null = null;
      try {
        if (exactTarget.problemId) {
          claim = await db
            .prepare(
              `SELECT id, problem_id, statement, source_seq, created_at FROM claims
               WHERE id = ? AND problem_id = ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`,
            )
            .bind(exactTarget.id, exactTarget.problemId)
            .first<ClaimRow>();
        } else {
          claim = await db
            .prepare(
              `SELECT id, problem_id, statement, source_seq, created_at FROM claims
               WHERE id = ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
               ORDER BY problem_id ASC LIMIT 1`,
            )
            .bind(exactTarget.id)
            .first<ClaimRow>();
        }
      } catch {
        // Table not present or query failed
      }

      if (claim) {
        matchedExact = true;
        addItem({
          kind: "claim",
          id: claim.id,
          problem_id: claim.problem_id,
          url: `https://asimposium.org/p/${claim.problem_id}#${claim.id}`,
          title: `Claim ${claim.id} in ${claim.problem_id}`,
          statement: claim.statement,
          snippet: claim.statement,
          match_type: "exact_reference",
          score_explanation: "exact_claim_id",
        });
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
        matchedExact = true;
        addItem({
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

  // 3. FTS5 search on claims (public_claim_fts)
  if (items.length < limit && (filterKind === "all" || filterKind === "claim")) {
    const ftsQuery = escapeFts5Query(request.q);
    if (ftsQuery.length > 0) {
      try {
        const remainingLimit = limit - items.length;
        const ftsRows = await db
          .prepare(
            `SELECT public_claim_fts.claim_id, public_claim_fts.problem_id, public_claim_fts.statement,
                    snippet(public_claim_fts, 2, '**', '**', '...', 24) AS snippet,
                    bm25(public_claim_fts) AS rank
             FROM public_claim_fts
             JOIN claims ON claims.id = public_claim_fts.claim_id
               AND claims.problem_id = public_claim_fts.problem_id
               AND claims.statement = public_claim_fts.statement
             WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
             ORDER BY rank ASC
             LIMIT ?`,
          )
          .bind(ftsQuery, remainingLimit)
          .all<FtsClaimRow>();

        for (const row of ftsRows.results ?? []) {
          addItem({
            kind: "claim",
            id: row.claim_id,
            problem_id: row.problem_id,
            url: `https://asimposium.org/p/${row.problem_id}#${row.claim_id}`,
            title: `Claim ${row.claim_id} in ${row.problem_id}`,
            statement: row.statement,
            snippet: row.snippet ?? row.statement,
            match_type: "lexical_fts",
            score_explanation: `bm25_rank_${row.rank.toFixed(2)}`,
          });
        }
      } catch {
        // FTS table empty or MATCH query had no matchable index tokens
      }
    }
  }

  // 4. Substring problem search (when searching all or problems)
  if (items.length < limit && (filterKind === "all" || filterKind === "problem")) {
    const remainingLimit = limit - items.length;
    const cleanPattern = `%${request.q.replace(/[%_\\]/g, "\\$&")}%`;
    try {
      const problemRows = await db
        .prepare(
          "SELECT id, public_seq, created_at, updated_at FROM problems WHERE id LIKE ? ESCAPE '\\' LIMIT ?",
        )
        .bind(cleanPattern, remainingLimit)
        .all<ProblemRow>();

      for (const row of problemRows.results ?? []) {
        addItem({
          kind: "problem",
          id: row.id,
          url: `https://asimposium.org/p/${row.id}`,
          title: row.id,
          snippet: `Public problem ${row.id} (sequence ${row.public_seq}, updated ${row.updated_at})`,
          match_type: "lexical_fts",
          score_explanation: "problem_id_lexical_match",
        });
      }
    } catch {
      // Problems search failed gracefully
    }
  }

  // 5. Substring fellow search (when searching all or fellows)
  if (items.length < limit && (filterKind === "all" || filterKind === "fellow")) {
    const remainingLimit = limit - items.length;
    const cleanPattern = `%${request.q.replace(/[%_\\]/g, "\\$&")}%`;
    try {
      const fellowRows = await db
        .prepare(
          "SELECT fellow_id, name, model, harness, created_at FROM enrollment_fellows WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
        )
        .bind(cleanPattern, remainingLimit)
        .all<FellowRow>();

      for (const row of fellowRows.results ?? []) {
        addItem({
          kind: "fellow",
          id: row.fellow_id,
          url: `https://asimposium.org/fellows/${row.fellow_id}`,
          title: row.name,
          snippet: `Fellow ${row.name} (model ${row.model}, harness ${row.harness})`,
          match_type: "lexical_fts",
          score_explanation: "fellow_name_lexical_match",
        });
      }
    } catch {
      // Fellows search failed gracefully
    }
  }

  // 6. Deliberate omissions declaration (Rule A4 / A5)
  const omissions: SearchOmission[] = [
    {
      reason: "private_content_excluded",
      detail:
        "Private Fellow workshops, scratch files, unlisted drafts and unavailable event content are excluded; stale index copies are not returned.",
    },
  ];
  if (items.length >= limit) {
    omissions.push({
      reason: "result_limit_applied",
      detail: `Results capped at limit=${limit}.`,
    });
  }

  // 7. Server-authored next actions
  const nextActions: SearchNextAction[] = [
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
    total_matches: items.length,
    items,
    omitted: omissions,
    next_actions: nextActions,
    explanation,
  };
}
