import type { SearchResultItem } from "@asimposium/contracts";
import { SEARCH_WINDOW_MAX, type SearchPageQuery } from "@asimposium/contracts/search-pagination";
import type { D1Database } from "@cloudflare/workers-types";
import {
  eventContentHiddenSql,
  hiddenByContentControlSql,
  PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL,
} from "../krater/public-content.ts";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "../ledger/citation-read-integrity.ts";
import { readPublishedProblemFormulations } from "../ledger/problem-formulation-read.ts";
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
  title: string;
}
interface ProblemStatementKey {
  kind: "problem-statement";
  id: string;
  public_seq: number;
  event_id: string;
  source_seq: number;
  statement_version: number;
  payload_sha256: string;
}
interface FellowKey {
  kind: "fellow";
  id: string;
  name: string;
  model: string;
  harness: string;
}
interface ExactKey {
  kind: "exact";
  item: SearchResultItem;
}
export type SearchWindowEntry = ClaimKey | ProblemKey | ProblemStatementKey | FellowKey | ExactKey;
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
JOIN problems p ON p.id = claims.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
  AND NOT (claims.problem_id = ? AND claims.id = ?)
ORDER BY rank ASC, public_claim_fts.problem_id ASC, public_claim_fts.claim_id ASC LIMIT ?`;

/** Problem discovery must not require knowing an opaque P-ID in advance.
 * Match public titles as literal text, not FTS operators or LIKE wildcards.
 * Keep the title in the window digest: a rename without a cursor change must
 * invalidate continuation just as a changed claim source does. Visibility is
 * checked in this SELECT, including a problem's latest hide/restore control. */
export const SEARCH_PROBLEM_KEYS_SQL = `SELECT 'problem' AS kind, p.id, p.public_seq, p.updated_at,
  CASE WHEN length(trim(p.title)) > 0 THEN p.title ELSE p.id END AS title
FROM problems p
WHERE (p.id LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')
  AND p.status <> 'private-draft' AND p.unlisted = 0 AND p.id <> ?
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
ORDER BY p.id COLLATE BINARY ASC LIMIT ?`;

/** A problem can be discoverable before it has any claims. Match only its
 * latest published formulation, never a draft, retained projection or an old
 * statement whose replacement was withdrawn. The window transfers pins only;
 * selected bodies are hash- and contract-verified by the canonical reader.
 * Title/ID matches already in the window are excluded without duplicate rows. */
export const SEARCH_PROBLEM_STATEMENT_KEYS_SQL = `WITH current_formulations AS (
  SELECT p.id, p.public_seq, p.current_statement_version,
    e.id AS event_id, e.seq AS source_seq, e.object_version AS statement_version,
    e.payload_sha256, e.type AS event_type,
    CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES}
      AND json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END AS payload_json
  FROM problems p JOIN events e ON e.id = (
    SELECT source.id FROM events source
    WHERE source.problem_id = p.id AND source.object_id = p.id
      AND source.object_kind = 'problem'
      AND source.type IN ('problem.admitted', 'problem.statement-revised')
      AND source.seq <= p.public_seq
    ORDER BY source.seq DESC LIMIT 1
  )
  JOIN event_content c ON c.event_id = e.id
    AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
  WHERE p.status <> 'private-draft' AND p.unlisted = 0
    AND p.id NOT IN (SELECT value FROM json_each(?))
    AND NOT ${eventContentHiddenSql("e")}
)
SELECT 'problem-statement' AS kind, id, public_seq, event_id, source_seq,
  statement_version, payload_sha256
FROM current_formulations
WHERE statement_version = current_statement_version
  AND json_extract(payload_json, '$.problem.id') = id
  AND json_extract(payload_json, '$.problem.current_statement_version') = statement_version
  AND json_extract(payload_json, '$.action') = CASE event_type
    WHEN 'problem.admitted' THEN 'publish' ELSE 'revise-statement' END
  AND json_type(payload_json, '$.problem.statement') = 'text'
  AND length(json_extract(payload_json, '$.problem.statement')) BETWEEN 1 AND 8192
  AND json_extract(payload_json, '$.problem.statement') LIKE ? ESCAPE '\\'
ORDER BY id COLLATE BINARY ASC LIMIT ?`;

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
JOIN problems p ON p.id = claims.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
ORDER BY selected.ordinal`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are not permitted in search identities.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !CONTROL_CHARACTERS.test(value)
  );
}
function validateEntry(entry: SearchWindowEntry): void {
  if (entry.kind === "exact") return;
  if (!validId(entry.id)) throw new Error("Invalid public search identity.");
  if (
    entry.kind === "claim" &&
    (!validId(entry.problem_id) ||
      !Number.isSafeInteger(entry.source_seq) ||
      entry.source_seq < 1 ||
      !/^[0-9a-f]{64}$/.test(entry.payload_sha256) ||
      !Number.isFinite(entry.rank))
  ) {
    throw new Error("Invalid public claim search pin.");
  }
  if (
    entry.kind === "problem" &&
    (!Number.isSafeInteger(entry.public_seq) ||
      entry.public_seq < 0 ||
      typeof entry.updated_at !== "string" ||
      typeof entry.title !== "string" ||
      entry.title.length === 0 ||
      entry.title.length > 2000)
  )
    throw new Error("Invalid public problem search pin.");
  if (
    entry.kind === "problem-statement" &&
    (!Number.isSafeInteger(entry.public_seq) ||
      !Number.isSafeInteger(entry.source_seq) ||
      entry.source_seq < 1 ||
      entry.source_seq > entry.public_seq ||
      !Number.isSafeInteger(entry.statement_version) ||
      entry.statement_version < 1 ||
      !validId(entry.event_id) ||
      !/^[0-9a-f]{64}$/.test(entry.payload_sha256))
  )
    throw new Error("Invalid public problem formulation search pin.");
  if (
    entry.kind === "fellow" &&
    [entry.name, entry.model, entry.harness].some(
      (value) => typeof value !== "string" || value.length > 2000,
    )
  ) {
    throw new Error("Invalid public Fellow search identity.");
  }
}
function identity(entry: SearchWindowEntry): string {
  const item = entry.kind === "exact" ? entry.item : entry;
  const kind = item.kind === "problem-statement" ? "problem" : item.kind;
  return JSON.stringify([kind, item.id, "problem_id" in item ? (item.problem_id ?? "") : ""]);
}

/** Preserve the existing order: exact match, BM25 claims with binary ID ties,
 * problem IDs/titles, published statements, then Fellow IDs. A lookahead
 * distinguishes a full last page from truncation. Changes anywhere in this
 * window invalidate continuation.
 * No shared-cache snapshot, server-side cursor row or private sequence exists. */
export async function readSearchWindow(
  db: D1Database,
  query: SearchPageQuery,
  ftsQuery: string,
  exactItems: readonly SearchResultItem[],
): Promise<SearchWindow> {
  const entries: SearchWindowEntry[] = exactItems.map((item) => ({ kind: "exact", item }));
  if (entries.length > 1) throw new Error("Ambiguous exact search identity.");
  const seen = new Set(entries.map(identity));
  const capacity = () => SEARCH_WINDOW_MAX + 1 - entries.length;
  const append = (rows: SearchWindowEntry[], maximum: number) => {
    if (!Array.isArray(rows) || rows.length > maximum)
      throw new Error("Invalid public search window.");
    for (const row of rows) {
      validateEntry(row);
      const key = identity(row);
      if (seen.has(key)) throw new Error("Duplicate public search identity.");
      seen.add(key);
      entries.push(row);
    }
  };
  const kind = query.kind ?? "all";
  if (ftsQuery && capacity() > 0 && (kind === "all" || kind === "claim")) {
    const exact = exactItems.find((item) => item.kind === "claim");
    const maximum = capacity();
    const rows = await db
      .prepare(SEARCH_CLAIM_KEYS_SQL)
      .bind(ftsQuery, exact?.problem_id ?? "", exact?.id ?? "", maximum)
      .all<ClaimKey>();
    append(rows.results, maximum);
  }
  const pattern = `%${query.q.replace(/[%_\\]/g, "\\$&")}%`;
  if (capacity() > 0 && (kind === "all" || kind === "problem")) {
    const maximum = capacity();
    const rows = await db
      .prepare(SEARCH_PROBLEM_KEYS_SQL)
      .bind(pattern, pattern, exactItems.find((item) => item.kind === "problem")?.id ?? "", maximum)
      .all<ProblemKey>();
    append(rows.results, maximum);
  }
  if (capacity() > 0 && (kind === "all" || kind === "problem")) {
    const maximum = capacity();
    const selectedProblems = entries.flatMap((entry) => {
      const item = entry.kind === "exact" ? entry.item : entry;
      return item.kind === "problem" ? [item.id] : [];
    });
    const rows = await db
      .prepare(SEARCH_PROBLEM_STATEMENT_KEYS_SQL)
      .bind(JSON.stringify(selectedProblems), pattern, maximum)
      .all<ProblemStatementKey>();
    append(rows.results, maximum);
  }
  if (capacity() > 0 && (kind === "all" || kind === "fellow")) {
    const maximum = capacity();
    const rows = await db
      .prepare(`SELECT 'fellow' AS kind, fellow_id AS id, name, model, harness FROM enrollment_fellows
      WHERE name LIKE ? ESCAPE '\\' AND fellow_id <> ? ORDER BY fellow_id COLLATE BINARY ASC LIMIT ?`)
      .bind(pattern, exactItems.find((item) => item.kind === "fellow")?.id ?? "", maximum)
      .all<FellowKey>();
    append(rows.results, maximum);
  }
  return {
    entries: entries.slice(0, SEARCH_WINDOW_MAX),
    truncated: entries.length > SEARCH_WINDOW_MAX,
  };
}

export async function hydrateSearchPage(
  db: D1Database,
  entries: readonly SearchWindowEntry[],
  ftsQuery: string,
  literalQuery: string,
): Promise<SearchResultItem[]> {
  if (entries.length > 50) throw new Error("Public search page exceeds the contract.");
  const claims = entries.filter((entry): entry is ClaimKey => entry.kind === "claim");
  const hydrated = new Map<string, SearchResultItem>();
  if (claims.length > 0) {
    const rows = (
      await db.prepare(SEARCH_CLAIM_PAGE_SQL).bind(JSON.stringify(claims), ftsQuery).all<{
        id: string;
        problem_id: string;
        statement: string;
        snippet: string | null;
        rank: number;
      }>()
    ).results;
    if (!Array.isArray(rows) || rows.length !== claims.length)
      throw new SearchContinuationError("changed");
    for (let i = 0; i < claims.length; i += 1) {
      const pin = claims[i],
        row = rows[i];
      if (
        !pin ||
        !row ||
        row.id !== pin.id ||
        row.problem_id !== pin.problem_id ||
        row.rank !== pin.rank ||
        typeof row.statement !== "string"
      )
        throw new SearchContinuationError("changed");
      hydrated.set(identity(pin), {
        kind: "claim",
        id: row.id,
        problem_id: row.problem_id,
        url: `https://asimposium.org/p/${encodeURIComponent(row.problem_id)}/claims/${encodeURIComponent(row.id)}`,
        title: `Claim ${row.id} in ${row.problem_id}`,
        statement: row.statement,
        snippet: (row.snippet ?? row.statement).slice(0, 2000),
        match_type: "lexical_fts",
        score_explanation: `bm25_rank_${row.rank.toFixed(2)}`,
      });
    }
  }
  const statements = entries.filter(
    (entry): entry is ProblemStatementKey => entry.kind === "problem-statement",
  );
  if (statements.length > 0) {
    const formulations = await readPublishedProblemFormulations(
      db,
      statements.map((entry) => ({ problem_id: entry.id, through: entry.public_seq })),
    );
    for (const pin of statements) {
      const formulation = formulations.get(pin.id);
      if (
        !formulation ||
        formulation.publication.event_id !== pin.event_id ||
        formulation.publication.seq !== pin.source_seq ||
        formulation.publication.payload_sha256 !== pin.payload_sha256 ||
        formulation.problem.current_statement_version !== pin.statement_version
      )
        throw new SearchContinuationError("changed");
      hydrated.set(identity(pin), {
        kind: "problem",
        id: pin.id,
        url: `https://asimposium.org/p/${encodeURIComponent(pin.id)}`,
        title: formulation.problem.title,
        version: pin.statement_version,
        statement: formulation.problem.statement,
        snippet: `S@${pin.statement_version} · ${statementExcerpt(formulation.problem.statement, literalQuery)}`,
        match_type: "lexical_fts",
        score_explanation: "current_published_statement_literal_match",
      });
    }
  }
  return entries.map((entry): SearchResultItem => {
    switch (entry.kind) {
      case "exact":
        return entry.item;
      case "claim":
      case "problem-statement": {
        const item = hydrated.get(identity(entry));
        if (!item) throw new SearchContinuationError("changed");
        return item;
      }
      case "problem":
        return {
          kind: "problem",
          id: entry.id,
          url: `https://asimposium.org/p/${encodeURIComponent(entry.id)}`,
          title: entry.title,
          snippet: `${entry.title} — Public problem ${entry.id} (sequence ${entry.public_seq}, updated ${entry.updated_at})`.slice(0, 2000),
          match_type: "lexical_fts",
          score_explanation: "problem_id_or_title_literal_match",
        };
      case "fellow":
        return {
          kind: "fellow",
          id: entry.id,
          url: `https://asimposium.org/fellows/${encodeURIComponent(entry.id)}`,
          title: entry.name,
          snippet: `Fellow ${entry.name} (model ${entry.model}, harness ${entry.harness})`.slice(
            0,
            2000,
          ),
          match_type: "lexical_fts",
          score_explanation: "fellow_name_lexical_match",
        };
      default: {
        const _exhaustive: never = entry;
        throw new Error(`Unexpected search window entry kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });
}

/** Keep a late matching passage visible without inventing highlighted markup
 * or Unicode equivalences. SQLite LIKE folds ASCII case only by default. */
function statementExcerpt(statement: string, query: string): string {
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const match = fold(statement).indexOf(fold(query));
  const start = Math.max(0, match - 160);
  const end = Math.min(statement.length, start + 1900);
  return `${start > 0 ? "…" : ""}${statement.slice(start, end)}${end < statement.length ? "…" : ""}`;
}
