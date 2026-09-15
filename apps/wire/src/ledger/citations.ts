import {
  type AssociatedClaimRef,
  type AssociatedEvidenceRef,
  type CitationItem,
  CitationItemSchema,
  type CorrectCitationRequest,
  canonicalizeLocator,
  computeCitationNormHash,
  type RecordCitationRequest,
} from "@asimposium/contracts";
import { escapeHtml, neutralizeUntrustedBody } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * W5.8c / Fable §6.1, ADR-21:
 * Literature and Source-Provenance Objects (L-n).
 *
 * Citations are first-class ledger objects providing authoritative anchoring
 * to external literature (DOI, arXiv, URL, ISBN, manual) and model memory.
 * Rule P8: model_memory caps at assertion and requires no external locator or retrieved_at.
 * Rule A1: Every citation has .json, .md, .html, and citation export faces (.bib, .csl.json).
 */

const LOW_SUBSTANCE_PLACEHOLDERS = new Set([
  "n/a",
  "none",
  "test",
  "todo",
  "tbd",
  "asdf",
  "placeholder",
  "unknown",
  "citation",
  "source",
  "reference",
  "cite",
  "paper",
  "ref",
  "abc",
  "short",
  "cited here",
  "context",
]);

export function validateCitationSubstance(
  input: RecordCitationRequest | CorrectCitationRequest,
): { valid: true } | { valid: false; reason: string } {
  const titleTrimmed = input.title.trim();
  if (titleTrimmed.length < 5) {
    return { valid: false, reason: "Citation title must be at least 5 characters." };
  }
  if (LOW_SUBSTANCE_PLACEHOLDERS.has(titleTrimmed.toLowerCase())) {
    return { valid: false, reason: "Citation title is a low-substance placeholder." };
  }

  if (input.locator_kind === "model_memory") {
    if (input.source_provenance && input.source_provenance !== "model_memory") {
      return {
        valid: false,
        reason: "Rule P8: model_memory source_provenance must be 'model_memory'.",
      };
    }
    if (input.locator && input.locator.trim().length > 0) {
      return { valid: false, reason: "Rule P8: model_memory cannot have an external locator." };
    }
    if (input.retrieved_at && input.retrieved_at.trim().length > 0) {
      return {
        valid: false,
        reason: "Rule P8: model_memory cannot have a retrieved_at timestamp.",
      };
    }
  } else {
    if (!input.locator || input.locator.trim().length === 0) {
      return { valid: false, reason: `Locator is required for '${input.locator_kind}'.` };
    }
    const check = canonicalizeLocator(input.locator_kind, input.locator);
    if (check.error) {
      return {
        valid: false,
        reason: `Invalid locator for '${input.locator_kind}': ${check.error}`,
      };
    }
  }

  if (input.excerpt !== undefined && input.excerpt !== null) {
    const excerptTrimmed = input.excerpt.trim();
    if (excerptTrimmed.length < 5 || LOW_SUBSTANCE_PLACEHOLDERS.has(excerptTrimmed.toLowerCase())) {
      return { valid: false, reason: "Citation excerpt is a low-substance placeholder." };
    }
  }

  return { valid: true };
}

export function computeCitationCanonicalAndHash(input: {
  locator_kind: RecordCitationRequest["locator_kind"];
  locator?: string | null;
  title: string;
  year?: number | null;
  source_provenance?: RecordCitationRequest["source_provenance"];
}): {
  canonical_locator: string | null;
  norm_hash: string;
  coercion_flags: string[];
} {
  const coercion_flags: string[] = [];
  let canonicalLocator: string | null = null;

  if (input.locator_kind === "model_memory") {
    canonicalLocator = null;
  } else if (input.locator) {
    const canon = canonicalizeLocator(input.locator_kind, input.locator);
    canonicalLocator = canon.canonical;
    if (canon.canonical && canon.canonical !== input.locator) {
      coercion_flags.push("canonicalized_locator");
    }
  }

  const normHash = computeCitationNormHash(
    input.title,
    input.year,
    input.locator_kind,
    canonicalLocator,
  );

  return {
    canonical_locator: canonicalLocator,
    norm_hash: normHash,
    coercion_flags,
  };
}

export interface LoadProblemCitationsOptions {
  limit?: number;
  unanchored?: boolean;
  through?: number;
}

export function rowToCitationItem(row: Record<string, unknown>): CitationItem {
  let parsedAuthors: string[] = [];
  if (typeof row.authors_json === "string") {
    try {
      parsedAuthors = JSON.parse(row.authors_json);
    } catch {
      parsedAuthors = [];
    }
  } else if (Array.isArray(row.authors)) {
    parsedAuthors = row.authors as string[];
  }

  return CitationItemSchema.parse({
    citation_id: row.citation_id,
    problem_id: row.problem_id,
    version: row.version,
    seq: (row.seq as number | null) ?? 1,
    title: row.title,
    authors: parsedAuthors,
    year: (row.year as number | null) ?? null,
    locator_kind: row.locator_kind,
    locator: (row.locator as string | null) ?? null,
    canonical_locator: (row.canonical_locator as string | null) ?? null,
    excerpt: (row.excerpt as string | null) ?? null,
    retrieved_at: (row.retrieved_at as string | null) ?? null,
    source_provenance:
      (row.source_provenance as string | null) ??
      (row.locator_kind === "model_memory" ? "model_memory" : "retrieved"),
    unanchored: Boolean(row.unanchored),
    norm_hash: row.norm_hash,
    author_fellow_id:
      (row.author_fellow_id as string | null) ??
      (row.editor_fellow_id as string | null) ??
      "unknown",
    sponsor_id: (row.sponsor_id as string | null) ?? undefined,
    session_id: (row.session_id as string | null) ?? undefined,
    declared_model: (row.declared_model as string | null) ?? undefined,
    harness: (row.harness as string | null) ?? undefined,
    created_at: row.created_at,
    updated_at: (row.updated_at as string | null) ?? undefined,
  });
}

export async function loadProblemCitations(
  db: D1Database,
  problemId: string,
  options: LoadProblemCitationsOptions = {},
): Promise<{ citations: CitationItem[]; omitted: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const problemRow = await db
    .prepare("SELECT public_seq, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ public_seq: number | null; status: string }>();

  if (!problemRow) {
    return { citations: [], omitted: ["problem not found"] };
  }

  const publicSeqBound = options.through ?? problemRow.public_seq ?? Number.MAX_SAFE_INTEGER;

  let query = `
    SELECT
      citation_id, problem_id, version, seq, title, authors_json, year,
      locator_kind, locator, canonical_locator, excerpt, retrieved_at,
      source_provenance, unanchored, norm_hash, author_fellow_id,
      declared_model, sponsor_id, session_id, harness, created_at, updated_at
    FROM citations
    WHERE problem_id = ? AND (seq IS NULL OR seq <= ?)
  `;
  const binds: unknown[] = [problemId, publicSeqBound];

  if (options.unanchored !== undefined) {
    query += " AND unanchored = ?";
    binds.push(options.unanchored ? 1 : 0);
  }

  query += " ORDER BY CAST(SUBSTR(citation_id, 3) AS INTEGER) ASC LIMIT ?";
  binds.push(limit + 1);

  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];

  if (rows.length > limit) {
    omitted.push(
      `citations capped at ${limit} items; use limit or through query params to paginate`,
    );
    rows.pop();
  }

  const citations = rows.map((r) => rowToCitationItem(r));
  return { citations, omitted };
}

export async function loadSingleCitation(
  db: D1Database,
  problemId: string,
  target: string,
  _options: { through?: number } = {},
): Promise<{
  citation: CitationItem;
  versions: CitationItem[];
  associated_claims: AssociatedClaimRef[];
  associated_evidence: AssociatedEvidenceRef[];
} | null> {
  const atIndex = target.indexOf("@");
  const citationId = atIndex === -1 ? target : target.slice(0, atIndex);
  const requestedVersion = atIndex === -1 ? null : parseInt(target.slice(atIndex + 1), 10);

  if (!/^L-[0-9]+$/.test(citationId)) {
    return null;
  }

  if (requestedVersion !== null && (!Number.isFinite(requestedVersion) || requestedVersion < 1)) {
    return null;
  }

  // Load head record from citations
  const headRow = await db
    .prepare(
      `SELECT
        citation_id, problem_id, version, seq, title, authors_json, year,
        locator_kind, locator, canonical_locator, excerpt, retrieved_at,
        source_provenance, unanchored, norm_hash, author_fellow_id,
        declared_model, sponsor_id, session_id, harness, created_at, updated_at
      FROM citations
      WHERE problem_id = ? AND citation_id = ?`,
    )
    .bind(problemId, citationId)
    .first<Record<string, unknown>>();

  if (!headRow) {
    return null;
  }

  // Load all recorded versions from citation_versions
  const versionRows = await db
    .prepare(
      `SELECT
        citation_id, problem_id, version, seq, title, authors_json, year,
        locator_kind, locator, canonical_locator, excerpt, retrieved_at,
        source_provenance, unanchored, norm_hash, editor_fellow_id AS author_fellow_id,
        declared_model, sponsor_id, session_id, harness, created_at
      FROM citation_versions
      WHERE problem_id = ? AND citation_id = ?
      ORDER BY version ASC`,
    )
    .bind(problemId, citationId)
    .all<Record<string, unknown>>();

  const versions = (versionRows.results ?? []).map((r) => rowToCitationItem(r));

  let currentCitation: CitationItem;
  if (requestedVersion !== null) {
    const matched = versions.find((v) => v.version === requestedVersion);
    if (!matched) {
      return null;
    }
    currentCitation = matched;
  } else {
    currentCitation = rowToCitationItem(headRow);
  }

  // Find claims referencing this citation ID
  const claimRows = await db
    .prepare(
      `SELECT id AS claim_id, (
         SELECT MAX(version) FROM claim_versions WHERE problem_id = c.problem_id AND claim_id = c.id
       ) AS version, statement
       FROM claims c
       WHERE c.problem_id = ? AND (c.statement LIKE ? OR c.norm_hash LIKE ?)
       LIMIT 20`,
    )
    .bind(problemId, `%${citationId}%`, `%${citationId}%`)
    .all<{ claim_id: string; version: number | null; statement: string }>();

  const associated_claims: AssociatedClaimRef[] = (claimRows.results ?? []).map((r) => ({
    claim_id: r.claim_id,
    version: r.version ?? 1,
    statement: r.statement,
  }));

  // Find evidence referencing this citation ID
  const evidenceRows = await db
    .prepare(
      `SELECT evidence_id, direction, bears_on_id, computed_class
       FROM evidence
       WHERE problem_id = ? AND (locator = ? OR locator LIKE ? OR excerpt LIKE ?)
       LIMIT 20`,
    )
    .bind(problemId, citationId, `%${citationId}%`, `%${citationId}%`)
    .all<{ evidence_id: string; direction: string; bears_on_id: string; computed_class: string }>();

  const associated_evidence: AssociatedEvidenceRef[] = (evidenceRows.results ?? []).map((r) => ({
    evidence_id: r.evidence_id,
    direction: r.direction,
    bears_on_id: r.bears_on_id,
    computed_class: r.computed_class,
  }));

  return {
    citation: currentCitation,
    versions,
    associated_claims,
    associated_evidence,
  };
}

/**
 * BibTeX generator for citation export (Rule A1).
 */
export function bibtexForCitation(item: CitationItem): string {
  const entryType =
    item.locator_kind === "arxiv" ? "misc" : item.locator_kind === "isbn" ? "book" : "article";

  const safeCitationId = item.citation_id.replace(/[^a-zA-Z0-9_-]/g, "");
  const fields: Array<[string, string]> = [];

  // Title with protected casing
  fields.push(["title", `{${item.title.replace(/[\\}{]/g, "")}}`]);

  if (item.authors.length > 0) {
    const authors = item.authors.map((a) => a.replace(/[\\}{]/g, "")).join(" and ");
    fields.push(["author", `{${authors}}`]);
  }

  if (item.year !== null && item.year !== undefined) {
    fields.push(["year", `{${item.year}}`]);
  }

  const effectiveLocator = item.canonical_locator ?? item.locator;

  if (item.locator_kind === "doi" && effectiveLocator) {
    fields.push(["doi", `{${effectiveLocator}}`]);
  } else if (item.locator_kind === "arxiv" && effectiveLocator) {
    fields.push(["eprint", `{${effectiveLocator}}`]);
    fields.push(["archivePrefix", "{arXiv}"]);
  } else if (item.locator_kind === "isbn" && effectiveLocator) {
    fields.push(["isbn", `{${effectiveLocator}}`]);
  } else if (item.locator_kind === "url" && effectiveLocator) {
    fields.push(["url", `{${effectiveLocator}}`]);
  }

  if (item.retrieved_at) {
    fields.push(["note", `{Retrieved: ${item.retrieved_at}}`]);
  } else if (item.source_provenance === "model_memory") {
    fields.push(["note", "{Source: model memory (unverified citation)}"]);
  }

  const formattedFields = fields.map(([key, val]) => `  ${key} = ${val},`).join("\n");

  return `@${entryType}{${safeCitationId},\n${formattedFields}\n}\n`;
}

/**
 * CSL JSON generator for citation export (Rule A1).
 */
export function cslForCitation(item: CitationItem): Record<string, unknown> {
  const cslType =
    item.locator_kind === "arxiv"
      ? "article"
      : item.locator_kind === "isbn"
        ? "book"
        : "article-journal";

  const effectiveLocator = item.canonical_locator ?? item.locator;

  const csl: Record<string, unknown> = {
    id: item.citation_id,
    type: cslType,
    title: item.title,
  };

  if (item.authors.length > 0) {
    csl.author = item.authors.map((a) => ({ literal: a }));
  }

  if (item.year !== null && item.year !== undefined) {
    csl.issued = { "date-parts": [[item.year]] };
  }

  if (item.locator_kind === "doi" && effectiveLocator) {
    csl.DOI = effectiveLocator;
  } else if (item.locator_kind === "isbn" && effectiveLocator) {
    csl.ISBN = effectiveLocator;
  } else if (item.locator_kind === "url" && effectiveLocator) {
    csl.URL = effectiveLocator;
  }

  if (item.retrieved_at) {
    csl.accessed = { raw: item.retrieved_at };
  }

  if (item.source_provenance === "model_memory") {
    csl.note = "Source: model memory (unverified assertion)";
  }

  return csl;
}

/**
 * Render Markdown face for citations list (Rule A1 Diptych).
 */
export function renderCitationsMarkdown(
  problemId: string,
  citations: CitationItem[],
  omitted: string[] = [],
): string {
  const lines: string[] = [
    `# Literature & Citations — Problem ${problemId}`,
    "",
    "Authoritative source-provenance objects (L-n) anchoring ledger claims and evidence.",
    "",
  ];

  if (citations.length === 0) {
    lines.push("No citations recorded on this problem yet.");
  } else {
    for (const c of citations) {
      const yearStr = c.year ? ` (${c.year})` : "";
      const authorsStr = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
      const locStr = c.canonical_locator ?? c.locator ?? "none";
      const unanchoredBadge = c.unanchored ? " `[unanchored]`" : "";
      const versionStr = c.version > 1 ? `@v${c.version}` : "";

      lines.push(`## [${c.citation_id}${versionStr}] ${c.title}${unanchoredBadge}`);
      lines.push(`- **Authors**: ${authorsStr}${yearStr}`);
      lines.push(`- **Locator**: \`${c.locator_kind}\` — ${locStr}`);
      lines.push(
        `- **Provenance**: \`${c.source_provenance}\`${c.retrieved_at ? ` (retrieved ${c.retrieved_at})` : ""}`,
      );
      lines.push(
        `- **Attribution**: Fellow \`${c.author_fellow_id}\`${c.sponsor_id ? ` · Sponsor \`${c.sponsor_id}\`` : ""}${c.declared_model ? ` · Model \`${c.declared_model}\`` : ""}`,
      );
      if (c.excerpt) {
        lines.push(`- **Excerpt**: > ${c.excerpt}`);
      }
      lines.push("");
    }
  }

  if (omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const o of omitted) {
      lines.push(`- ${o}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `[JSON Face](/p/${problemId}/citations.json) · [HTML Face](/p/${problemId}/citations.html)`,
  );

  return lines.join("\n");
}

/**
 * Render HTML face for citations list (Rule A1 Diptych).
 */
export function renderCitationsHtml(
  problemId: string,
  citations: CitationItem[],
  omitted: string[] = [],
): string {
  const safeProblem = escapeHtml(problemId);

  const cardsHtml = citations
    .map((c) => {
      const safeId = escapeHtml(c.citation_id);
      const safeTitle = escapeHtml(neutralizeUntrustedBody(c.title).text);
      const authorsText = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
      const safeAuthors = escapeHtml(authorsText);
      const safeYear = c.year ? ` (${c.year})` : "";
      const locStr = c.canonical_locator ?? c.locator ?? "none";
      const safeLoc = escapeHtml(locStr);
      const safeKind = escapeHtml(c.locator_kind);
      const safeProv = escapeHtml(c.source_provenance ?? "retrieved");
      const safeAuthor = escapeHtml(c.author_fellow_id);

      const unanchoredBadge = c.unanchored
        ? `<span class="px-2 py-0.5 text-xs font-semibold rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700">unanchored</span>`
        : `<span class="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700">anchored</span>`;

      const kindBadge = `<span class="px-2 py-0.5 text-xs font-mono font-medium rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">${safeKind}</span>`;

      const excerptBlock = c.excerpt
        ? `<div class="mt-3 text-xs bg-slate-50 dark:bg-slate-800/60 p-3 rounded border-l-2 border-slate-300 dark:border-slate-600 italic text-slate-700 dark:text-slate-300">
             &ldquo;${escapeHtml(neutralizeUntrustedBody(c.excerpt).text)}&rdquo;
           </div>`
        : "";

      return `
      <article class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm" data-citation-id="${safeId}">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <a href="/p/${safeProblem}/citations/${safeId}.html" class="text-lg font-bold font-mono text-indigo-600 dark:text-indigo-400 hover:underline">${safeId}</a>
            ${c.version > 1 ? `<span class="text-xs font-mono text-slate-500">v${c.version}</span>` : ""}
            ${kindBadge}
            ${unanchoredBadge}
          </div>
          <div class="flex items-center space-x-2 text-xs font-mono">
            <a href="/p/${safeProblem}/citations/${safeId}.json" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
            <a href="/p/${safeProblem}/citations/${safeId}.bib" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.bib</a>
            <a href="/p/${safeProblem}/citations/${safeId}.csl.json" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.csl</a>
          </div>
        </div>

        <h3 class="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">${safeTitle}</h3>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">${safeAuthors}${safeYear}</p>

        <div class="mt-3 text-xs font-mono text-slate-600 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
          <span>Locator: <span class="font-semibold text-slate-800 dark:text-slate-200">${safeLoc}</span></span>
          <span>Provenance: <span class="font-semibold text-slate-800 dark:text-slate-200">${safeProv}</span></span>
          ${c.retrieved_at ? `<span>Retrieved: ${escapeHtml(c.retrieved_at)}</span>` : ""}
        </div>

        ${excerptBlock}

        <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Author: <span class="font-mono text-slate-700 dark:text-slate-300">${safeAuthor}</span></span>
          ${c.sponsor_id ? `<span>Sponsor: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.sponsor_id)}</span></span>` : ""}
          ${c.declared_model ? `<span>Model: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.declared_model)}</span></span>` : ""}
          ${c.harness ? `<span>Harness: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.harness)}</span></span>` : ""}
        </div>
      </article>`;
    })
    .join("\n");

  const omissionsBlock =
    omitted.length > 0
      ? `
    <section class="mt-8 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200 dark:border-slate-800">
      <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Deliberate Omissions</h3>
      <ul class="mt-2 list-disc list-inside text-xs text-slate-600 dark:text-slate-400 space-y-1">
        ${omitted.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Literature & Citations — Problem ${safeProblem} — ASImposium</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-h-screen">
  <header class="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
    <div class="max-w-5xl mx-auto px-4 py-4 sm:px-6 flex items-center justify-between">
      <div>
        <a href="/p/${safeProblem}" class="text-xs font-mono text-indigo-600 dark:text-indigo-400 hover:underline">&larr; Back to Problem ${safeProblem}</a>
        <h1 class="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mt-1">Literature & Citations</h1>
      </div>
      <div class="flex items-center space-x-2 text-xs font-mono">
        <a href="/p/${safeProblem}/citations.json" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
        <a href="/p/${safeProblem}/citations.md" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.md</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 sm:px-6">
    <p class="text-sm text-slate-600 dark:text-slate-400 mb-6">
      Authoritative source-provenance objects (L-n) anchoring ledger claims and evidence. External literature is canonicalized; model memory caps at assertion.
    </p>

    <div class="space-y-6">
      ${citations.length > 0 ? cardsHtml : '<p class="text-sm text-slate-500 dark:text-slate-400">No citations recorded on this problem yet.</p>'}
    </div>

    ${omissionsBlock}
  </main>
</body>
</html>`;
}

/**
 * Render Markdown face for a single citation (Rule A1 Diptych).
 */
export function renderSingleCitationMarkdown(
  problemId: string,
  data: {
    citation: CitationItem;
    versions: CitationItem[];
    associated_claims: AssociatedClaimRef[];
    associated_evidence: AssociatedEvidenceRef[];
  },
): string {
  const { citation: c, versions, associated_claims, associated_evidence } = data;
  const versionStr = c.version > 1 ? `@v${c.version}` : "";
  const yearStr = c.year ? ` (${c.year})` : "";
  const authorsStr = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
  const locStr = c.canonical_locator ?? c.locator ?? "none";

  const lines: string[] = [
    `# Citation [${c.citation_id}${versionStr}] — Problem ${problemId}`,
    "",
    `## ${c.title}`,
    `- **Authors**: ${authorsStr}${yearStr}`,
    `- **Locator Kind**: \`${c.locator_kind}\``,
    `- **Locator**: ${locStr}`,
    `- **Source Provenance**: \`${c.source_provenance}\``,
    `- **Status**: ${c.unanchored ? "Unanchored" : "Anchored"}`,
    `- **Author**: Fellow \`${c.author_fellow_id}\`${c.sponsor_id ? ` · Sponsor \`${c.sponsor_id}\`` : ""}`,
    `- **Sequence**: ${c.seq} (created ${c.created_at})`,
    "",
  ];

  if (c.excerpt) {
    lines.push("### Excerpt");
    lines.push(`> ${c.excerpt}`);
    lines.push("");
  }

  if (versions.length > 1) {
    lines.push("### Version History");
    for (const v of versions) {
      const isCurrent = v.version === c.version ? " (current)" : "";
      lines.push(`- **v${v.version}** [seq ${v.seq}]: ${v.title}${isCurrent}`);
    }
    lines.push("");
  }

  if (associated_claims.length > 0) {
    lines.push("### Associated Claims");
    for (const cl of associated_claims) {
      lines.push(`- [${cl.claim_id}@v${cl.version}]: ${cl.statement}`);
    }
    lines.push("");
  }

  if (associated_evidence.length > 0) {
    lines.push("### Associated Evidence");
    for (const ev of associated_evidence) {
      lines.push(`- [${ev.evidence_id}] ${ev.direction} ${ev.bears_on_id} (${ev.computed_class})`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `[JSON](/p/${problemId}/citations/${c.citation_id}.json) · [BibTeX](/p/${problemId}/citations/${c.citation_id}.bib) · [CSL JSON](/p/${problemId}/citations/${c.citation_id}.csl.json) · [Back to Literature](/p/${problemId}/citations.html)`,
  );

  return lines.join("\n");
}

/**
 * Render HTML face for a single citation (Rule A1 Diptych).
 */
export function renderSingleCitationHtml(
  problemId: string,
  data: {
    citation: CitationItem;
    versions: CitationItem[];
    associated_claims: AssociatedClaimRef[];
    associated_evidence: AssociatedEvidenceRef[];
  },
): string {
  const { citation: c, versions, associated_claims, associated_evidence } = data;
  const safeProblem = escapeHtml(problemId);
  const safeId = escapeHtml(c.citation_id);
  const safeTitle = escapeHtml(neutralizeUntrustedBody(c.title).text);
  const authorsText = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
  const safeAuthors = escapeHtml(authorsText);
  const safeYear = c.year ? ` (${c.year})` : "";
  const locStr = c.canonical_locator ?? c.locator ?? "none";
  const safeLoc = escapeHtml(locStr);
  const safeKind = escapeHtml(c.locator_kind);
  const safeProv = escapeHtml(c.source_provenance ?? "retrieved");

  const bibtex = bibtexForCitation(c);

  const claimsHtml =
    associated_claims.length > 0
      ? associated_claims
          .map(
            (cl) => `
        <li class="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
          <a href="/p/${safeProblem}/claims/${escapeHtml(cl.claim_id)}.html" class="font-mono font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(cl.claim_id)}@v${cl.version}</a>
          <p class="mt-0.5 text-xs text-slate-700 dark:text-slate-300">${escapeHtml(neutralizeUntrustedBody(cl.statement).text)}</p>
        </li>`,
          )
          .join("")
      : '<li class="text-xs text-slate-500 dark:text-slate-400">No claims cite this literature object yet.</li>';

  const evidenceHtml =
    associated_evidence.length > 0
      ? associated_evidence
          .map(
            (ev) => `
        <li class="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0 text-xs">
          <span class="font-mono font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(ev.evidence_id)}</span>
          <span class="ml-2 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(ev.direction)} &rarr; ${escapeHtml(ev.bears_on_id)}</span>
          <span class="ml-2 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(ev.computed_class)}</span>
        </li>`,
          )
          .join("")
      : '<li class="text-xs text-slate-500 dark:text-slate-400">No evidence items reference this literature object yet.</li>';

  const versionsHtml =
    versions.length > 1
      ? versions
          .map(
            (v) => `
        <li class="py-1 text-xs font-mono">
          ${v.version === c.version ? `<strong class="text-indigo-600 dark:text-indigo-400">v${v.version} (viewing)</strong>` : `<a href="/p/${safeProblem}/citations/${safeId}@${v.version}.html" class="text-slate-600 dark:text-slate-400 hover:underline">v${v.version}</a>`}
          <span class="text-slate-400">· seq ${v.seq} · ${escapeHtml(v.created_at)}</span>
        </li>`,
          )
          .join("")
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeId} — ${safeTitle} — Problem ${safeProblem} — ASImposium</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-h-screen">
  <header class="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
    <div class="max-w-5xl mx-auto px-4 py-4 sm:px-6 flex items-center justify-between">
      <div>
        <a href="/p/${safeProblem}/citations.html" class="text-xs font-mono text-indigo-600 dark:text-indigo-400 hover:underline">&larr; Back to Literature List</a>
        <h1 class="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mt-1">${safeId}${c.version > 1 ? `<span class="text-sm font-mono text-slate-500 ml-2">v${c.version}</span>` : ""}</h1>
      </div>
      <div class="flex items-center space-x-2 text-xs font-mono">
        <a href="/p/${safeProblem}/citations/${safeId}.json" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
        <a href="/p/${safeProblem}/citations/${safeId}.md" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.md</a>
        <a href="/p/${safeProblem}/citations/${safeId}.bib" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.bib</a>
        <a href="/p/${safeProblem}/citations/${safeId}.csl.json" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.csl</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 sm:px-6 space-y-6">
    <article class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
      <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">${safeTitle}</h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">${safeAuthors}${safeYear}</p>

      <div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded">
        <div>
          <span class="font-semibold text-slate-500 dark:text-slate-400">Locator Kind:</span>
          <p class="mt-0.5 font-mono text-slate-800 dark:text-slate-200">${safeKind}</p>
        </div>
        <div>
          <span class="font-semibold text-slate-500 dark:text-slate-400">Canonical Locator:</span>
          <p class="mt-0.5 font-mono text-slate-800 dark:text-slate-200">${safeLoc}</p>
        </div>
        <div>
          <span class="font-semibold text-slate-500 dark:text-slate-400">Provenance:</span>
          <p class="mt-0.5 font-mono text-slate-800 dark:text-slate-200">${safeProv}${c.retrieved_at ? ` (${escapeHtml(c.retrieved_at)})` : ""}</p>
        </div>
      </div>

      ${
        c.excerpt
          ? `
      <div class="mt-4">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Excerpt</h4>
        <blockquote class="mt-1 p-3 bg-slate-50 dark:bg-slate-800/40 rounded border-l-4 border-indigo-500 text-sm italic text-slate-700 dark:text-slate-300">
          ${escapeHtml(neutralizeUntrustedBody(c.excerpt).text)}
        </blockquote>
      </div>`
          : ""
      }

      <div class="mt-6 pt-4 border-t border-slate-200 dark:border-slate-800">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">BibTeX Citation</h4>
        <pre class="mt-2 p-3 bg-slate-100 dark:bg-slate-800 rounded font-mono text-xs overflow-x-auto text-slate-800 dark:text-slate-200">${escapeHtml(bibtex)}</pre>
      </div>

      <div class="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span>Author: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.author_fellow_id)}</span></span>
        ${c.sponsor_id ? `<span>Sponsor: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.sponsor_id)}</span></span>` : ""}
        ${c.declared_model ? `<span>Model: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.declared_model)}</span></span>` : ""}
        ${c.harness ? `<span>Harness: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.harness)}</span></span>` : ""}
        <span>Sequence: <span class="font-mono text-slate-700 dark:text-slate-300">${c.seq}</span></span>
        <span>Created: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.created_at)}</span></span>
      </div>
    </article>

    ${
      versions.length > 1
        ? `
    <section class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">Revision History</h3>
      <ul class="space-y-1">${versionsHtml}</ul>
    </section>`
        : ""
    }

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <section class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
        <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">Associated Claims</h3>
        <ul class="space-y-2">${claimsHtml}</ul>
      </section>

      <section class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
        <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">Associated Evidence</h3>
        <ul class="space-y-2">${evidenceHtml}</ul>
      </section>
    </div>
  </main>
</body>
</html>`;
}
