import {
  canonicalizeLocator,
  type CitationItem,
  type CitationsListQuery,
  CitationsListQuerySchema,
} from "@asimposium/contracts/citations";

export const CITATIONS_PAGE_SIZE = 8;

export function parseCitationViewQuery(value: unknown): CitationsListQuery | null {
  const parsed = CitationsListQuerySchema.safeParse(value);
  return parsed.success ? { ...parsed.data, limit: parsed.data.limit ?? CITATIONS_PAGE_SIZE } : null;
}

/** A locator is authored data. Only recognized DOI/arXiv identifiers and
 * credential-free HTTP(S) URLs become external links; it is never fetched here. */
export function citationLocatorLink(item: Pick<CitationItem,
  "locator_kind" | "locator" | "canonical_locator">): string | null {
  const locator = item.canonical_locator ?? item.locator;
  if (typeof locator !== "string" || locator.trim() !== locator || /[\u0000-\u0020\u007f]/.test(locator))
    return null;
  const normalized = canonicalizeLocator(item.locator_kind, locator);
  if (normalized.error !== undefined || normalized.canonical === null) return null;
  if (item.locator_kind === "doi") return `https://doi.org/${normalized.canonical}`;
  if (item.locator_kind === "arxiv") return `https://arxiv.org/abs/${normalized.canonical}`;
  if (item.locator_kind !== "url") return null;
  try {
    const url = new URL(normalized.canonical);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

export function citationProvenanceLabel(item: Pick<CitationItem, "source_provenance">): string {
  return item.source_provenance === "retrieved"
    ? "Retrieved (Fellow-declared)" : "Model memory (self-declared)";
}

export function citationOmissionText(reason: string): string {
  switch (reason) {
    case "page_limit": return "More citation publication positions remain. Continue at this ledger snapshot, including when this page has no readable matches.";
    case "content_unavailable": return "Some citation content is currently withheld or unavailable. An omitted source is not evidence that no citation was registered.";
    case "byte_limit": return "Some complete citation records exceed this page's source-byte budget. Their scientific text has not been silently clipped.";
    case "history_unavailable": return "Some citation version history is unavailable. An older record has not been substituted for the requested version.";
    case "history_limit": return "This page contains a bounded selection of citation versions. A known exact version can still be read using its versioned link.";
    case "association_limit": return "Associated scientific work is a bounded selection of recorded references, not a complete citation census.";
    default: return reason;
  }
}
