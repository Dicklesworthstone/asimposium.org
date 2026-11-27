import type { SearchResultItem } from "@asimposium/contracts";
import { SEARCH_WINDOW_MAX, type SearchPageQuery } from "@asimposium/contracts/search-pagination";
import type { D1Database } from "@cloudflare/workers-types";
import {
  offScopeClaimSql,
  offScopeProblemSql,
  offScopePublicationSql,
} from "../discovery/public-scope.ts";
import {
  eventContentHiddenSql,
  PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL,
} from "../krater/public-content.ts";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "../ledger/citation-read-integrity.ts";
import {
  type PublishedProblemFormulation,
  readPublishedProblemFormulations,
} from "../ledger/problem-formulation-read.ts";
import { checkedScientificPayload } from "../ledger/scientific-checks.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import { SearchContinuationError } from "./continuation.ts";

interface ClaimKey {
  kind: "claim";
  id: string;
  problem_id: string;
  source_seq: number;
  payload_sha256: string;
  rank: number;
}
export interface SearchProblemPublication {
  id: string;
  public_seq: number;
  event_id: string;
  source_seq: number;
  statement_version: number;
  payload_sha256: string;
  screening_provenance: string | null;
}
interface ProblemKey extends SearchProblemPublication {
  kind: "problem";
  updated_at: string;
  title: string;
}
interface ProblemStatementKey extends SearchProblemPublication {
  kind: "problem-statement";
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

/** Shared by exact lookup and every lexical problem/claim selection. Filters
 * run before the bounded window, never after a page has been sliced. */
export const SEARCH_PROBLEM_FILTER_SQL = `(? IS NULL OR p.status = ?)
  AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(p.areas) area WHERE area.value = ?))`;

// Lexical ranking and its lag indicator share the global discovery scope.
// An explicit reference still identifies its public object with its notice.
export const SEARCH_CLAIM_DISCOVERY_SQL = `NOT ${offScopeProblemSql("p.id", "p.public_seq")}
  AND NOT ${offScopeClaimSql("p.id", "claims.id", "p.public_seq")}`;

export function searchProblemFilterBindings(query: SearchPageQuery): readonly (string | null)[] {
  return [query.status ?? null, query.status ?? null, query.area ?? null, query.area ?? null];
}

/** The projection selects the current publication. Its immutable envelope
 * supplies the version and digest, and present-day controls still apply. */
export const SEARCH_CLAIM_SOURCE_SQL = `JOIN events publication ON publication.problem_id = claims.problem_id
  AND publication.seq = claims.source_seq AND publication.seq <= p.public_seq
  AND publication.object_id = claims.id AND publication.object_kind = 'claim'
  AND publication.type IN ('claim.created', 'claim.revised')
  AND publication.payload_sha256 = claims.payload_sha256
JOIN event_content content ON content.event_id = publication.id
  AND content.payload_sha256 = publication.payload_sha256 AND content.redacted_at IS NULL
  AND NOT ${eventContentHiddenSql("publication")}`;

// Only selected results transfer source bodies. The cursor window stays small.
export const SEARCH_CLAIM_SOURCE_COLUMNS = `publication.object_version AS version,
  publication.type AS event_type, publication.payload_sha256,
  CASE WHEN length(CAST(content.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES}
    THEN content.payload_json END AS payload_json`;

export interface SearchClaimPublication {
  id: string;
  statement: string;
  version: number;
  event_type: string;
  payload_sha256: string;
  payload_json: string | null;
}

export async function verifiedSearchClaimVersion(row: SearchClaimPublication): Promise<number> {
  if (row.payload_json === null || !Number.isSafeInteger(row.version) || row.version < 1)
    throw new Error("The search result has no verifiable publication.");
  const payload = await checkedScientificPayload({
    payload_sha256: row.payload_sha256,
    payload_json: row.payload_json,
  });
  if (
    payload.claim_id !== row.id ||
    payload.statement !== row.statement ||
    (row.version === 1
      ? row.event_type !== "claim.created"
      : row.event_type !== "claim.revised" || payload.base_version !== row.version - 1)
  )
    throw new Error("The search result differs from its claim publication.");
  return row.version;
}

export const SEARCH_CLAIM_KEYS_SQL = `SELECT 'claim' AS kind, public_claim_fts.claim_id AS id,
  public_claim_fts.problem_id, claims.source_seq, claims.payload_sha256,
  bm25(public_claim_fts) AS rank
FROM public_claim_fts
JOIN claims ON claims.id = public_claim_fts.claim_id AND claims.problem_id = public_claim_fts.problem_id
  AND claims.statement = public_claim_fts.statement
JOIN problems p ON p.id = claims.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
WHERE public_claim_fts MATCH ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
  AND ${SEARCH_CLAIM_DISCOVERY_SQL}
  AND ${SEARCH_PROBLEM_FILTER_SQL}
  AND NOT (claims.problem_id = ? AND claims.id = ?)
ORDER BY rank ASC, public_claim_fts.problem_id ASC, public_claim_fts.claim_id ASC LIMIT ?`;

/** Titles, exact IDs and statement matches share one publication boundary.
 * Select the latest source before checking availability: a withdrawn current
 * formulation never falls back to retained problem columns or an older source.
 * Only bounded pins cross the DB boundary; the canonical reader verifies the
 * selected page's complete payloads. Current source notices also bind cursors. */
const SEARCH_PROBLEM_SOURCES_SQL = `WITH current_formulations AS (
  SELECT p.id, p.public_seq, p.current_statement_version,
    e.id AS event_id, e.seq AS source_seq, e.object_version AS statement_version,
    e.payload_sha256, e.type AS event_type,
    CASE WHEN length(CAST(screening.provenance_json AS BLOB)) <= 4096
      THEN screening.provenance_json
      WHEN screening.provenance_json IS NOT NULL THEN 'invalid' END AS screening_provenance,
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
  LEFT JOIN screening_publications screening ON screening.event_id = e.id
  WHERE p.status <> 'private-draft' AND p.unlisted = 0
    AND NOT ${eventContentHiddenSql("e")}
    AND ${SEARCH_PROBLEM_FILTER_SQL}
), readable_formulations AS (
SELECT id, public_seq, event_id, source_seq, statement_version, payload_sha256,
  screening_provenance,
  json_extract(payload_json, '$.problem.title') AS title,
  json_extract(payload_json, '$.problem.statement') AS statement,
  json_extract(payload_json, '$.problem.updated_at') AS updated_at
FROM current_formulations
WHERE statement_version = current_statement_version
  AND json_extract(payload_json, '$.problem.id') = id
  AND json_extract(payload_json, '$.problem.current_statement_version') = statement_version
  AND json_extract(payload_json, '$.action') = CASE event_type
    WHEN 'problem.admitted' THEN 'publish' ELSE 'revise-statement' END
  AND json_type(payload_json, '$.problem.title') = 'text'
  AND length(json_extract(payload_json, '$.problem.title')) BETWEEN 1 AND 2000
  AND json_type(payload_json, '$.problem.statement') = 'text'
  AND length(json_extract(payload_json, '$.problem.statement')) BETWEEN 1 AND 8192
)`;

const SEARCH_PROBLEM_PIN_COLUMNS = `id, public_seq, event_id, source_seq,
  statement_version, payload_sha256, screening_provenance`;

export const SEARCH_EXACT_PROBLEM_SQL = `${SEARCH_PROBLEM_SOURCES_SQL}
SELECT ${SEARCH_PROBLEM_PIN_COLUMNS} FROM readable_formulations WHERE id = ?`;

/** Literal title matching never reads a mutable or withdrawn title. */
export const SEARCH_PROBLEM_KEYS_SQL = `${SEARCH_PROBLEM_SOURCES_SQL}
SELECT 'problem' AS kind, ${SEARCH_PROBLEM_PIN_COLUMNS}, title, updated_at
FROM readable_formulations
WHERE (id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') AND id <> ?
  AND NOT ${offScopePublicationSql("readable_formulations.event_id")}
ORDER BY id COLLATE BINARY ASC LIMIT ?`;

/** A problem needs no claims or matching title words to be discoverable. */
export const SEARCH_PROBLEM_STATEMENT_KEYS_SQL = `${SEARCH_PROBLEM_SOURCES_SQL}
SELECT 'problem-statement' AS kind, ${SEARCH_PROBLEM_PIN_COLUMNS}
FROM readable_formulations
WHERE id NOT IN (SELECT value FROM json_each(?)) AND statement LIKE ? ESCAPE '\\'
  AND NOT ${offScopePublicationSql("readable_formulations.event_id")}
ORDER BY id COLLATE BINARY ASC LIMIT ?`;

export function verifiedSearchProblem(
  pin: SearchProblemPublication,
  formulation: PublishedProblemFormulation | undefined,
): PublishedProblemFormulation {
  if (
    formulation === undefined ||
    formulation.problem.id !== pin.id ||
    formulation.publication.event_id !== pin.event_id ||
    formulation.publication.seq !== pin.source_seq ||
    formulation.publication.payload_sha256 !== pin.payload_sha256 ||
    formulation.problem.current_statement_version !== pin.statement_version ||
    JSON.stringify(formulation.screening_notice) !==
      JSON.stringify(publicationScreeningNotice(pin.screening_provenance))
  )
    throw new SearchContinuationError("changed");
  return formulation;
}

/** Only a page of claim bodies crosses the DB boundary. The bounded window
 * contains identities, source pins and ranks, never 500 scientific bodies. */
export const SEARCH_CLAIM_PAGE_SQL = `WITH selected AS (
  SELECT CAST(key AS INTEGER) AS ordinal, json_extract(value,'$.id') AS id,
    json_extract(value,'$.problem_id') AS problem_id, json_extract(value,'$.source_seq') AS source_seq,
    json_extract(value,'$.payload_sha256') AS payload_sha256 FROM json_each(?)
)
SELECT public_claim_fts.claim_id AS id, public_claim_fts.problem_id, claims.statement,
  ${SEARCH_CLAIM_SOURCE_COLUMNS},
  (SELECT s.provenance_json FROM events e JOIN screening_publications s ON s.event_id = e.id
    WHERE e.problem_id = claims.problem_id AND e.seq = claims.source_seq) AS screening_provenance,
  snippet(public_claim_fts, 2, '**', '**', '...', 24) AS snippet, bm25(public_claim_fts) AS rank
FROM public_claim_fts
JOIN claims ON claims.id = public_claim_fts.claim_id AND claims.problem_id = public_claim_fts.problem_id
  AND claims.statement = public_claim_fts.statement
JOIN selected ON selected.id = claims.id AND selected.problem_id = claims.problem_id
  AND selected.source_seq = claims.source_seq AND selected.payload_sha256 = claims.payload_sha256
JOIN problems p ON p.id = claims.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
${SEARCH_CLAIM_SOURCE_SQL}
WHERE public_claim_fts MATCH ?
  AND ${SEARCH_CLAIM_DISCOVERY_SQL}
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
    (entry.kind === "problem-statement" || entry.kind === "problem") &&
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
      .bind(
        ftsQuery,
        ...searchProblemFilterBindings(query),
        exact?.problem_id ?? "",
        exact?.id ?? "",
        maximum,
      )
      .all<ClaimKey>();
    append(rows.results, maximum);
  }
  const pattern = `%${query.q.replace(/[%_\\]/g, "\\$&")}%`;
  if (capacity() > 0 && (kind === "all" || kind === "problem")) {
    const maximum = capacity();
    const rows = await db
      .prepare(SEARCH_PROBLEM_KEYS_SQL)
      .bind(
        ...searchProblemFilterBindings(query),
        pattern,
        pattern,
        exactItems.find((item) => item.kind === "problem")?.id ?? "",
        maximum,
      )
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
      .bind(
        ...searchProblemFilterBindings(query),
        JSON.stringify(selectedProblems),
        pattern,
        maximum,
      )
      .all<ProblemStatementKey>();
    append(rows.results, maximum);
  }
  if (
    capacity() > 0 &&
    query.area === undefined &&
    query.status === undefined &&
    (kind === "all" || kind === "fellow")
  ) {
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
      await db.prepare(SEARCH_CLAIM_PAGE_SQL).bind(JSON.stringify(claims), ftsQuery).all<
        SearchClaimPublication & {
          problem_id: string;
          snippet: string | null;
          rank: number;
          screening_provenance?: string | null;
        }
      >()
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
      const version = await verifiedSearchClaimVersion(row);
      const screeningNotice = publicationScreeningNotice(row.screening_provenance);
      hydrated.set(identity(pin), {
        kind: "claim",
        id: row.id,
        problem_id: row.problem_id,
        version,
        url: `https://asimposium.org/p/${encodeURIComponent(row.problem_id)}/claims/${encodeURIComponent(row.id)}@${version}`,
        title: `Claim ${row.id}@${version} in ${row.problem_id}`,
        statement: row.statement,
        snippet: (row.snippet ?? row.statement).slice(0, 2000),
        match_type: "lexical_fts",
        score_explanation: `bm25_rank_${row.rank.toFixed(2)}`,
        ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
      });
    }
  }
  const statements = entries.filter(
    (entry): entry is ProblemStatementKey | ProblemKey =>
      entry.kind === "problem-statement" || entry.kind === "problem",
  );
  if (statements.length > 0) {
    const formulations = await readPublishedProblemFormulations(db, [
      ...new Map(
        statements.map((entry) => [entry.id, { problem_id: entry.id, through: entry.public_seq }]),
      ).values(),
    ]);
    for (const pin of statements) {
      const formulation = verifiedSearchProblem(pin, formulations.get(pin.id));
      if (pin.kind === "problem") {
        if (
          formulation.problem.title !== pin.title ||
          formulation.problem.updated_at !== pin.updated_at
        )
          throw new SearchContinuationError("changed");
        hydrated.set(identity(pin), {
          kind: "problem",
          id: pin.id,
          url: `https://asimposium.org/p/${encodeURIComponent(pin.id)}`,
          title: pin.title,
          snippet:
            `${pin.title} — Public problem ${pin.id} (sequence ${pin.public_seq}, updated ${pin.updated_at})`.slice(
              0,
              2000,
            ),
          match_type: "lexical_fts",
          score_explanation: "problem_id_or_title_literal_match",
          ...(formulation.screening_notice === undefined
            ? {}
            : { screening_notice: formulation.screening_notice }),
        });
        continue;
      }
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
        ...(formulation.screening_notice === undefined
          ? {}
          : { screening_notice: formulation.screening_notice }),
      });
    }
  }
  return entries.map((entry): SearchResultItem => {
    switch (entry.kind) {
      case "exact":
        return entry.item;
      case "claim":
      case "problem":
      case "problem-statement": {
        const item = hydrated.get(identity(entry));
        if (!item) throw new SearchContinuationError("changed");
        return item;
      }
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
