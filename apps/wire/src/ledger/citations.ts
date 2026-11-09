import {
  type AssociatedClaimRef,
  type AssociatedEvidenceRef,
  type CitationItem,
  CitationItemSchema,
  type CitationReadQuery,
  type CitationsListQuery,
  type CorrectCitationRequest,
  canonicalizeLocator,
  computeCitationNormHash,
  type RecordCitationRequest,
} from "@asimposium/contracts";
import { type CitationsListResponse, citationsListPath } from "@asimposium/contracts/citations";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
  screeningNoticeText,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type CommittedCitationRead,
  type CommittedCitationsRead,
  loadCommittedCitation,
  loadCommittedCitations,
} from "./citation-read";

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

export type LoadProblemCitationsOptions = CitationsListQuery;

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

/** The same canonical contract validates every committed public citation. */
function decodeCommittedCitation(candidate: unknown): CitationItem | undefined {
  const parsed = CitationItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Lists and literature packs share event-derived, redaction-safe publication authority. */
export async function loadProblemCitations(
  db: D1Database,
  problemId: string,
  options: LoadProblemCitationsOptions = {},
): Promise<CommittedCitationsRead> {
  return loadCommittedCitations(db, problemId, options, decodeCommittedCitation);
}

/** Exact faces and bibliography exports never substitute another version's bytes. */
export async function loadSingleCitation(
  db: D1Database,
  problemId: string,
  target: string,
  options: CitationReadQuery = {},
): Promise<CommittedCitationRead | null> {
  return loadCommittedCitation(db, problemId, target, options, decodeCommittedCitation);
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

  const notes =
    item.screening_notice === undefined ? [] : [screeningNoticeText(item.screening_notice)];
  if (item.retrieved_at) {
    notes.push(`Retrieved: ${item.retrieved_at}`);
  } else if (item.source_provenance === "model_memory") {
    notes.push("Source: model memory (unverified citation)");
  }
  // Keep one standard note field. Authored provenance cannot close that field
  // and replace the publication warning with a duplicate BibTeX field.
  if (notes.length > 0) fields.push(["note", `{${notes.join(" ").replace(/[\\}{]/g, "")}}`]);

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

  const notes =
    item.screening_notice === undefined ? [] : [screeningNoticeText(item.screening_notice)];
  if (item.source_provenance === "model_memory") {
    notes.push("Source: model memory (unverified assertion)");
  }
  if (notes.length > 0) csl.note = notes.join(" ");

  return csl;
}

/**
 * Render Markdown face for citations list (Rule A1 Diptych).
 */
type CitationListRenderView = Pick<
  CitationsListResponse,
  "cursor" | "after" | "scanned_through" | "next_after" | "unanchored"
> & { limit?: number };
type CitationReadRenderView = { cursor: number; omitted: string[]; target?: string };

function listRenderQuery(view?: CitationListRenderView, after = view?.after): CitationsListQuery {
  return view === undefined
    ? {}
    : {
        through: view.cursor,
        after,
        ...(view.limit === undefined ? {} : { limit: view.limit }),
        ...(view.unanchored === null ? {} : { unanchored: view.unanchored }),
      };
}

export function renderCitationsMarkdown(
  problemId: string,
  citations: CitationItem[],
  omitted: string[] = [],
  view?: CitationListRenderView,
): string {
  const cut = view === undefined ? "" : `?through=${view.cursor}`;
  const lines: string[] = [
    `# Literature & Citations — Problem ${safeInlineProse(problemId)}`,
    "",
    "Recorded source-provenance objects (L-n). Metadata and retrieval are author supplied; the platform does not verify external sources. Model memory is an unverified assertion.",
    ...(view === undefined
      ? []
      : [
          "",
          `Public ledger cursor: ${view.cursor}. Latest citation versions are ordered by publication sequence; examined through event #${view.scanned_through}.`,
        ]),
    "",
  ];

  if (citations.length === 0) {
    lines.push("No readable citations were returned in this public view; see omissions below.");
  } else {
    for (const c of citations) {
      const yearStr = c.year ? ` (${c.year})` : "";
      const authorsStr = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
      const locStr = c.canonical_locator ?? c.locator ?? "none";
      const unanchoredBadge = c.unanchored ? " `[unanchored]`" : "";
      const versionStr = c.version > 1 ? `@v${c.version}` : "";

      lines.push(
        `## [${c.citation_id}${versionStr}] ${safeInlineProse(c.title)}${unanchoredBadge}`,
      );
      if (c.screening_notice !== undefined)
        lines.push("", screeningNoticeText(c.screening_notice), "");
      lines.push(`- **Authors**: ${safeInlineProse(authorsStr)}${yearStr}`);
      lines.push(`- **Locator**: ${safeCodeSpan(c.locator_kind)} — ${safeInlineProse(locStr)}`);
      lines.push(
        `- **Provenance**: ${safeCodeSpan(c.source_provenance)}${c.retrieved_at ? ` (retrieved ${safeInlineProse(c.retrieved_at)})` : ""}`,
      );
      lines.push(
        `- **Attribution**: Fellow ${safeCodeSpan(c.author_fellow_id)}${c.sponsor_id ? ` · Sponsor ${safeCodeSpan(c.sponsor_id)}` : ""}${c.session_id ? ` · Session ${safeCodeSpan(c.session_id)}` : ""}${c.declared_model ? ` · Model (self-declared) ${safeCodeSpan(c.declared_model)}` : ""}${c.harness ? ` · Harness (self-declared) ${safeCodeSpan(c.harness)}` : ""}`,
      );
      if (c.excerpt) {
        lines.push(`- **Excerpt (untrusted)**: ${safeInlineProse(c.excerpt)}`);
      }
      lines.push(
        `[Exact citation version](/p/${encodeURIComponent(problemId)}/citations/${c.citation_id}@${c.version}.md${cut})`,
      );
      lines.push("");
    }
  }

  if (omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const o of omitted) {
      lines.push(`- ${safeInlineProse(o)}`);
    }
    lines.push("");
  }

  lines.push("---");
  if (view?.next_after !== undefined && view.next_after !== null)
    lines.push(
      `[More citations](${citationsListPath(problemId, "md", listRenderQuery(view, view.next_after))})`,
      "",
    );
  lines.push(
    `[JSON Face](${citationsListPath(problemId, "json", listRenderQuery(view))}) · [HTML Face](${citationsListPath(problemId, "html", listRenderQuery(view))})`,
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
  view?: CitationListRenderView,
): string {
  const safeProblem = escapeHtml(problemId);
  const cut = view === undefined ? "" : `?through=${view.cursor}`;
  const next =
    view?.next_after === undefined || view.next_after === null
      ? null
      : citationsListPath(problemId, "html", listRenderQuery(view, view.next_after));

  const cardsHtml = citations
    .map((c) => {
      const safeId = escapeHtml(c.citation_id);
      const safeTarget = `${safeId}@${c.version}`;
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
            <a href="/p/${safeProblem}/citations/${safeTarget}.html${cut}" class="text-lg font-bold font-mono text-indigo-600 dark:text-indigo-400 hover:underline">${safeId}</a>
            ${c.version > 1 ? `<span class="text-xs font-mono text-slate-500">v${c.version}</span>` : ""}
            ${kindBadge}
            ${unanchoredBadge}
          </div>
          <div class="flex items-center space-x-2 text-xs font-mono">
            <a href="/p/${safeProblem}/citations/${safeTarget}.json${cut}" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
            <a href="/p/${safeProblem}/citations/${safeTarget}.bib${cut}" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.bib</a>
            <a href="/p/${safeProblem}/citations/${safeTarget}.csl.json${cut}" class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.csl</a>
          </div>
        </div>

        ${c.screening_notice === undefined ? "" : `<aside role="note" data-screening-notice="${escapeHtml(c.screening_notice.notice)}">${escapeHtml(screeningNoticeText(c.screening_notice))}</aside>`}
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
        <a href="${escapeHtml(citationsListPath(problemId, "json", listRenderQuery(view)))}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
        <a href="${escapeHtml(citationsListPath(problemId, "md", listRenderQuery(view)))}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.md</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 sm:px-6">
    <p class="text-sm text-slate-600 dark:text-slate-400 mb-6">
      Recorded source-provenance objects (L-n). Metadata and retrieval are author supplied; the platform does not verify external sources. Model memory is an unverified assertion.
    </p>
    ${view === undefined ? "" : `<p>Public ledger cursor: ${view.cursor}. Latest citation versions are ordered by publication sequence; examined through event #${view.scanned_through}.</p>`}

    <div class="space-y-6">
      ${citations.length > 0 ? cardsHtml : '<p class="text-sm text-slate-500 dark:text-slate-400">No readable citations were returned in this public view; see omissions below.</p>'}
    </div>

    ${omissionsBlock}
    ${next === null ? "" : `<nav aria-label="Citation pages"><a rel="next" href="${escapeHtml(next)}">More citations</a></nav>`}
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
  view?: CitationReadRenderView,
): string {
  const { citation: c, versions, associated_claims, associated_evidence } = data;
  const cut = view === undefined ? "" : `?through=${view.cursor}`;
  const formatTarget =
    view?.target === undefined ? `${c.citation_id}@${c.version}` : encodeURIComponent(view.target);
  const versionStr = c.version > 1 ? `@v${c.version}` : "";
  const yearStr = c.year ? ` (${c.year})` : "";
  const authorsStr = c.authors.length > 0 ? c.authors.join(", ") : "Unknown Author";
  const locStr = c.canonical_locator ?? c.locator ?? "none";

  const lines: string[] = [
    `# Citation [${c.citation_id}${versionStr}] — Problem ${safeInlineProse(problemId)}`,
    "",
    "Author-supplied citation metadata is untrusted data. Available history may omit withdrawn content. Backlinks are bounded textual mentions, not proof of scientific support or an exhaustive citation graph.",
    ...(view === undefined ? [] : ["", `Public ledger cursor: ${view.cursor}.`]),
    ...(c.screening_notice === undefined ? [] : ["", screeningNoticeText(c.screening_notice), ""]),
    `## ${safeInlineProse(c.title)}`,
    `- **Authors**: ${safeInlineProse(authorsStr)}${yearStr}`,
    `- **Locator Kind**: ${safeCodeSpan(c.locator_kind)}`,
    `- **Locator**: ${safeInlineProse(locStr)}`,
    `- **Source Provenance**: ${safeCodeSpan(c.source_provenance)}`,
    `- **Verification**: ${c.source_provenance === "model_memory" ? "Model memory is an unverified assertion." : "Retrieval is author reported; the platform does not verify the external source."}`,
    ...(c.retrieved_at
      ? [`- **Retrieved (author reported)**: ${safeInlineProse(c.retrieved_at)}`]
      : []),
    `- **Status**: ${c.unanchored ? "Unanchored" : "Anchored"}`,
    `- **Author**: Fellow ${safeCodeSpan(c.author_fellow_id)}${c.sponsor_id ? ` · Sponsor ${safeCodeSpan(c.sponsor_id)}` : ""}${c.session_id ? ` · Session ${safeCodeSpan(c.session_id)}` : ""}${c.declared_model ? ` · Model (self-declared) ${safeCodeSpan(c.declared_model)}` : ""}${c.harness ? ` · Harness (self-declared) ${safeCodeSpan(c.harness)}` : ""}`,
    `- **Sequence**: ${c.seq} (created ${safeInlineProse(c.created_at)})`,
    "",
  ];

  if (c.excerpt) {
    lines.push("### Excerpt");
    lines.push(`> ${safeInlineProse(c.excerpt)}`);
    lines.push("");
  }

  if (versions.some((v) => v.version !== c.version)) {
    lines.push("### Available Version History");
    for (const v of versions) {
      const isCurrent = v.version === c.version ? " (viewing)" : "";
      lines.push(
        `- [v${v.version}](/p/${encodeURIComponent(problemId)}/citations/${c.citation_id}@${v.version}.md${cut}) [seq ${v.seq}]: ${v.screening_notice === undefined ? "" : `${screeningNoticeText(v.screening_notice)} `}${safeInlineProse(v.title)}${isCurrent}`,
      );
    }
    lines.push("");
  }

  if (associated_claims.length > 0) {
    lines.push("### Associated Claims");
    for (const cl of associated_claims) {
      lines.push(
        `- [${safeInlineProse(cl.claim_id)}@v${cl.version}](/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(cl.claim_id)}@${cl.version}.md${cut}): ${cl.screening_notice === undefined ? "" : `${screeningNoticeText(cl.screening_notice)} `}${safeInlineProse(cl.statement)}`,
      );
    }
    lines.push("");
  }

  if (associated_evidence.length > 0) {
    lines.push("### Associated Evidence");
    for (const ev of associated_evidence) {
      lines.push(
        `- ${safeCodeSpan(ev.evidence_id)} ${safeInlineProse(ev.direction)} ${safeCodeSpan(ev.bears_on_id)} (${safeInlineProse(ev.computed_class)})${ev.screening_notice === undefined ? "" : ` — ${screeningNoticeText(ev.screening_notice)}`}`,
      );
    }
    lines.push("");
  }

  if (view && view.omitted.length > 0) {
    lines.push("### Deliberate Omissions", "");
    for (const omission of view.omitted) lines.push(`- ${safeInlineProse(omission)}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(
    `[JSON](/p/${encodeURIComponent(problemId)}/citations/${formatTarget}.json${cut}) · [BibTeX](/p/${encodeURIComponent(problemId)}/citations/${formatTarget}.bib${cut}) · [CSL JSON](/p/${encodeURIComponent(problemId)}/citations/${formatTarget}.csl.json${cut}) · [Back to Literature](/p/${encodeURIComponent(problemId)}/citations.html${cut})`,
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
  view?: CitationReadRenderView,
): string {
  const { citation: c, versions, associated_claims, associated_evidence } = data;
  const cut = view === undefined ? "" : `?through=${view.cursor}`;
  const safeProblem = escapeHtml(problemId);
  const safeId = escapeHtml(c.citation_id);
  const safeTarget =
    view?.target === undefined ? `${safeId}@${c.version}` : encodeURIComponent(view.target);
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
          <a href="/p/${safeProblem}/claims/${encodeURIComponent(cl.claim_id)}@${cl.version}.html${cut}" class="font-mono font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(cl.claim_id)}@v${cl.version}</a>
          ${cl.screening_notice === undefined ? "" : `<aside role="note" data-screening-notice="screening-warning">${escapeHtml(screeningNoticeText(cl.screening_notice))}</aside>`}
          <p class="mt-0.5 text-xs text-slate-700 dark:text-slate-300">${escapeHtml(neutralizeUntrustedBody(cl.statement).text)}</p>
        </li>`,
          )
          .join("")
      : '<li class="text-xs text-slate-500 dark:text-slate-400">No matching claim mentions were returned in this bounded view.</li>';

  const evidenceHtml =
    associated_evidence.length > 0
      ? associated_evidence
          .map(
            (ev) => `
        <li class="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0 text-xs">
          <span class="font-mono font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(ev.evidence_id)}</span>
          ${ev.screening_notice === undefined ? "" : `<aside role="note" data-screening-notice="${escapeHtml(ev.screening_notice.notice)}">${escapeHtml(screeningNoticeText(ev.screening_notice))}</aside>`}
          <span class="ml-2 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(ev.direction)} &rarr; ${escapeHtml(ev.bears_on_id)}</span>
          <span class="ml-2 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(ev.computed_class)}</span>
        </li>`,
          )
          .join("")
      : '<li class="text-xs text-slate-500 dark:text-slate-400">No matching evidence mentions were returned in this bounded view.</li>';

  const versionsHtml = versions.some((v) => v.version !== c.version)
    ? versions
        .map(
          (v) => `
        <li class="py-1 text-xs font-mono">
          ${v.version === c.version ? `<strong class="text-indigo-600 dark:text-indigo-400">v${v.version} (viewing)</strong>` : `<a href="/p/${safeProblem}/citations/${safeId}@${v.version}.html${cut}" class="text-slate-600 dark:text-slate-400 hover:underline">v${v.version}</a>`}
          <span class="text-slate-400">· seq ${v.seq} · ${escapeHtml(v.created_at)}</span>
          ${v.screening_notice === undefined ? "" : `<aside role="note" data-screening-notice="${escapeHtml(v.screening_notice.notice)}">${escapeHtml(screeningNoticeText(v.screening_notice))}</aside>`}
          <span class="text-slate-700 dark:text-slate-300">${escapeHtml(neutralizeUntrustedBody(v.title).text)}</span>
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
        <a href="/p/${safeProblem}/citations.html${cut}" class="text-xs font-mono text-indigo-600 dark:text-indigo-400 hover:underline">&larr; Back to Literature List</a>
        <h1 class="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mt-1">${safeId}${c.version > 1 ? `<span class="text-sm font-mono text-slate-500 ml-2">v${c.version}</span>` : ""}</h1>
      </div>
      <div class="flex items-center space-x-2 text-xs font-mono">
        <a href="/p/${safeProblem}/citations/${safeTarget}.json${cut}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
        <a href="/p/${safeProblem}/citations/${safeTarget}.md${cut}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.md</a>
        <a href="/p/${safeProblem}/citations/${safeTarget}.bib${cut}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.bib</a>
        <a href="/p/${safeProblem}/citations/${safeTarget}.csl.json${cut}" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.csl</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 sm:px-6 space-y-6">
    <p>Author-supplied citation metadata is untrusted data. Available history may omit withdrawn content. Backlinks are bounded textual mentions, not proof of scientific support or an exhaustive citation graph.</p>
    ${view === undefined ? "" : `<p>Public ledger cursor: ${view.cursor}.</p>`}
    <p>${c.source_provenance === "model_memory" ? "Model memory is an unverified assertion." : "Retrieval is author reported; the platform does not verify the external source."}</p>
    ${view && view.omitted.length > 0 ? `<aside aria-label="Deliberate omissions"><h2>Deliberate Omissions</h2><ul>${view.omitted.map((omission) => `<li>${escapeHtml(omission)}</li>`).join("")}</ul></aside>` : ""}
    <article class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
      ${c.screening_notice === undefined ? "" : `<aside role="note" data-screening-notice="${escapeHtml(c.screening_notice.notice)}">${escapeHtml(screeningNoticeText(c.screening_notice))}</aside>`}
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
        ${c.session_id ? `<span>Session: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.session_id)}</span></span>` : ""}
        ${c.declared_model ? `<span>Model: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.declared_model)}</span></span>` : ""}
        ${c.harness ? `<span>Harness: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.harness)}</span></span>` : ""}
        <span>Sequence: <span class="font-mono text-slate-700 dark:text-slate-300">${c.seq}</span></span>
        <span>Created: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.created_at)}</span></span>
      </div>
    </article>

    ${
      versions.some((v) => v.version !== c.version)
        ? `
    <section class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">Available Revision History</h3>
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
