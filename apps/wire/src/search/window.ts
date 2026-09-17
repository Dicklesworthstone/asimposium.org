import type { SearchQueryRequest, SearchResultItem } from "@asimposium/contracts";
import { SEARCH_WINDOW_MAX } from "@asimposium/contracts/search-pagination";
import type { D1Database } from "@cloudflare/workers-types";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content.ts";
import { SearchContinuationError } from "./continuation.ts";

interface ClaimKey {
  kind: "claim";
  id: string;
  problem_id: string;
  source_seq: number;
  payload_sha256: string;
  rank: number;
}
interface ProblemKey {
  kind: "problem";
  id: string;
  public_seq: number;
  updated_at: string;
}
interface FellowKey {
  kind: "fellow";
  id: string;
  name: string;
  model: string;
  harness: string;
}
interface ExactKey { kind: "exact"; item: SearchResultItem }
export type SearchWindowEntry = ClaimKey | ProblemKey | FellowKey | ExactKey;
export interface SearchWindow {
  entries: SearchWindowEntry[];
  truncated: boolean;
}

export const SEARCH_CLAIM_KEYS_SQL = `SELECT 'claim' AS kind, public_claim_fts.claim_id AS id,
  public_claim_fts.problem_id, claims.source_seq, claims.payload_sha256,
  bm25(public_claim_fts) AS rank
FROM public_claim_fts
JOIN claims ON claims.id = public_claim_fts.claim_id AND claims.problem_id = public_claim_fts.problem_id
  AND claims.statement = public_claim_fts.statement
JOIN problems p ON p.id = claims.problem_id AND p.status != 'private-draft' AND p.unlisted = 0
WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
  AND NOT (claims.problem_id = ? AND claims.id = ?)
ORDER BY rank ASC, public_claim_fts.problem_id ASC, public_claim_fts.claim_id ASC LIMIT ?`;

/** Only a page of claim bodies crosses the DB boundary. The bounded window
 * contains identities, source pins and ranks, never 500 scientific bodies. */
export const SEARCH_CLAIM_PAGE_SQL = `WITH selected AS (
  SELECT CAST(key AS INTEGER) AS ordinal, json_extract(value,'$.id') AS id,
    json_extract(value,'$.problem_id') AS problem_id, json_extract(value,'$.source_seq') AS source_seq,
    json_extract(value,'$.payload_sha256') AS payload_sha256 FROM json_each(?)
)
SELECT public_claim_fts.claim_id AS id, public_claim_fts.problem_id, claims.statement,
  snippet(public_claim_fts, 2, '**', '**', '...', 24) AS snippet, bm25(public_claim_fts) AS rank
FROM public_claim_fts
JOIN claims ON claims.id = public_claim_fts.claim_id AND claims.problem_id = public_claim_fts.problem_id
  AND claims.statement = public_claim_fts.statement
JOIN selected ON selected.id = claims.id AND selected.problem_id = claims.problem_id
  AND selected.source_seq = claims.source_seq AND selected.payload_sha256 = claims.payload_sha256
JOIN problems p ON p.id = claims.problem_id AND p.status != 'private-draft' AND p.unlisted = 0
WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
ORDER BY selected.ordinal`;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
function validateEntry(entry: SearchWindowEntry): void {
  if (entry.kind === "exact") return;
  if (!validId(entry.id)) throw new Error("Invalid public search identity.");
  if (entry.kind === "claim" && (!validId(entry.problem_id) || !Number.isSafeInteger(entry.source_seq) ||
      entry.source_seq < 1 || !/^[0-9a-f]{64}$/.test(entry.payload_sha256) || !Number.isFinite(entry.rank))) {
    throw new Error("Invalid public claim search pin.");
  }
  if (entry.kind === "problem" && (!Number.isSafeInteger(entry.public_seq) || entry.public_seq < 0 ||
      typeof entry.updated_at !== "string")) throw new Error("Invalid public problem search pin.");
  if (entry.kind === "fellow" && [entry.name, entry.model, entry.harness].some((value) => typeof value !== "string" || value.length > 2000)) {
    throw new Error("Invalid public Fellow search identity.");
  }
}
function identity(entry: SearchWindowEntry): string {
  const item = entry.kind === "exact" ? entry.item : entry;
  return JSON.stringify([item.kind, item.id, "problem_id" in item ? item.problem_id ?? "" : ""]);
}

/** Preserve the existing order: exact match, BM25 claims with binary ID ties,
 * problem IDs, then Fellow IDs. A lookahead distinguishes a full last page
 * from truncation. Changes anywhere in this window invalidate continuation.
 * No shared-cache snapshot, server-side cursor row or private sequence exists. */
export async function readSearchWindow(
  db: D1Database,
  query: SearchQueryRequest,
  ftsQuery: string,
  exactItems: readonly SearchResultItem[],
): Promise<SearchWindow> {
  const entries: SearchWindowEntry[] = exactItems.map((item) => ({ kind: "exact", item }));
  if (entries.length > 1) throw new Error("Ambiguous exact search identity.");
  const seen = new Set(entries.map(identity));
  const capacity = () => SEARCH_WINDOW_MAX + 1 - entries.length;
  const append = (rows: SearchWindowEntry[], maximum: number) => {
    if (!Array.isArray(rows) || rows.length > maximum) throw new Error("Invalid public search window.");
    for (const row of rows) {
      validateEntry(row);
      const key = identity(row);
      if (seen.has(key)) throw new Error("Duplicate public search identity.");
      seen.add(key); entries.push(row);
    }
  };
  const kind = query.kind ?? "all";
  if (ftsQuery && capacity() > 0 && (kind === "all" || kind === "claim")) {
    const exact = exactItems.find((item) => item.kind === "claim");
    const maximum = capacity();
    const rows = await db.prepare(SEARCH_CLAIM_KEYS_SQL)
      .bind(ftsQuery, exact?.problem_id ?? "", exact?.id ?? "", maximum).all<ClaimKey>();
    append(rows.results, maximum);
  }
  const pattern = `%${query.q.replace(/[%_\\]/g, "\\$&")}%`;
  if (capacity() > 0 && (kind === "all" || kind === "problem")) {
    const maximum = capacity();
    const rows = await db.prepare(`SELECT 'problem' AS kind, id, public_seq, updated_at FROM problems
      WHERE id LIKE ? ESCAPE '\\' AND status != 'private-draft' AND unlisted = 0 AND id <> ?
      ORDER BY id COLLATE BINARY ASC LIMIT ?`)
      .bind(pattern, exactItems.find((item) => item.kind === "problem")?.id ?? "", maximum).all<ProblemKey>();
    append(rows.results, maximum);
  }
  if (capacity() > 0 && (kind === "all" || kind === "fellow")) {
    const maximum = capacity();
    const rows = await db.prepare(`SELECT 'fellow' AS kind, fellow_id AS id, name, model, harness FROM enrollment_fellows
      WHERE name LIKE ? ESCAPE '\\' AND fellow_id <> ? ORDER BY fellow_id COLLATE BINARY ASC LIMIT ?`)
      .bind(pattern, exactItems.find((item) => item.kind === "fellow")?.id ?? "", maximum).all<FellowKey>();
    append(rows.results, maximum);
  }
  return { entries: entries.slice(0, SEARCH_WINDOW_MAX), truncated: entries.length > SEARCH_WINDOW_MAX };
}

export async function hydrateSearchPage(
  db: D1Database,
  entries: readonly SearchWindowEntry[],
  ftsQuery: string,
): Promise<SearchResultItem[]> {
  if (entries.length > 50) throw new Error("Public search page exceeds the contract.");
  const claims = entries.filter((entry): entry is ClaimKey => entry.kind === "claim");
  const hydrated = new Map<string, SearchResultItem>();
  if (claims.length > 0) {
    const rows = (await db.prepare(SEARCH_CLAIM_PAGE_SQL).bind(JSON.stringify(claims), ftsQuery)
      .all<{ id: string; problem_id: string; statement: string; snippet: string | null; rank: number }>()).results;
    if (!Array.isArray(rows) || rows.length !== claims.length) throw new SearchContinuationError("changed");
    for (let i = 0; i < claims.length; i += 1) {
      const pin = claims[i], row = rows[i];
      if (!pin || !row || row.id !== pin.id || row.problem_id !== pin.problem_id || row.rank !== pin.rank ||
          typeof row.statement !== "string") throw new SearchContinuationError("changed");
      hydrated.set(identity(pin), {
        kind: "claim", id: row.id, problem_id: row.problem_id,
        url: `https://asimposium.org/p/${encodeURIComponent(row.problem_id)}/claims/${encodeURIComponent(row.id)}`,
        title: `Claim ${row.id} in ${row.problem_id}`, statement: row.statement,
        snippet: (row.snippet ?? row.statement).slice(0, 2000), match_type: "lexical_fts",
        score_explanation: `bm25_rank_${row.rank.toFixed(2)}`,
      });
    }
  }
  return entries.map((entry): SearchResultItem => {
    switch (entry.kind) {
      case "exact": return entry.item;
      case "claim": {
        const item = hydrated.get(identity(entry));
        if (!item) throw new SearchContinuationError("changed");
        return item;
      }
      case "problem": return {
        kind: "problem", id: entry.id, url: `https://asimposium.org/p/${encodeURIComponent(entry.id)}`,
        title: entry.id, snippet: `Public problem ${entry.id} (sequence ${entry.public_seq}, updated ${entry.updated_at})`,
        match_type: "lexical_fts", score_explanation: "problem_id_lexical_match",
      };
      case "fellow": return {
        kind: "fellow", id: entry.id, url: `https://asimposium.org/fellows/${encodeURIComponent(entry.id)}`,
        title: entry.name, snippet: `Fellow ${entry.name} (model ${entry.model}, harness ${entry.harness})`.slice(0, 2000),
        match_type: "lexical_fts", score_explanation: "fellow_name_lexical_match",
      };
    }
  });
}
