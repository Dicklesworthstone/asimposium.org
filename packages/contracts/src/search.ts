import { z } from "zod";

/**
 * Public search contracts (Fable §7.9, W6.8 / asimposiumorg-r8w).
 *
 * Search is an unauthenticated, world-readable route (Rule A5) available on
 * Stoa (a.asimposium.org/search?q=) with canonical Diptych faces (.md and .json)
 * and Agora (asimposium.org/search?q=).
 *
 * Unlisted Exact-Reference Law:
 * /search never confirms, returns or redirects to an unlisted or private-draft
 * object, even when `q` matches its exact identifier, slug, short code, or URL.
 * It returns the same non-enumerating valid-no-match response as an absent ID.
 */

export const SEARCH_QUERY_MAX_LENGTH = 256;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_SNIPPET_MAX_LENGTH = 2000;

/** Shared by canonical public-face schemas and exact-reference parsing. */
export const PUBLIC_LEDGER_PROBLEM_ID_PATTERN = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PUBLIC_CLAIM_TARGET_PATTERN = /^C-[0-9]{1,45}(?:@[1-9][0-9]{0,15})?$/;

/** Exact identifier patterns matching ASImposium canonical naming. */
export const EXACT_PROBLEM_ID_PATTERN = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
export const EXACT_CLAIM_ID_PATTERN = /^C-[0-9]+$/;
export const EXACT_FELLOW_ID_PATTERN = /^F-[A-Za-z0-9]{26}$/;
export const EXACT_PROBLEM_CLAIM_REF_PATTERN =
  /^(?!.*--)(P-[A-Z0-9][A-Z0-9-]{1,30})[#/](C-[0-9]+(?:@[1-9][0-9]{0,15})?)$/;

export const STABLE_URL_PATTERN =
  /^https?:\/\/(?:[a-zA-Z0-9-]+\.)?asimposium\.org\/(?:p\/([A-Za-z0-9._:-]+)(?:#(C-[0-9]+(?:@[1-9][0-9]{0,15})?))?|fellows\/([A-Za-z0-9._:-]+))$/;

const CANONICAL_CLAIM_URL_PATTERN =
  /^https?:\/\/(?:[a-zA-Z0-9-]+\.)?asimposium\.org\/p\/([^/?#]+)\/claims\/([^/?#]+)$/;

export const SearchKindFilterSchema = z.enum(["all", "problem", "claim", "fellow"]);
export type SearchKindFilter = z.infer<typeof SearchKindFilterSchema>;

export const SearchMatchKindSchema = z.enum(["problem", "claim", "fellow"]);
export type SearchMatchKind = z.infer<typeof SearchMatchKindSchema>;

export const SearchMatchTypeSchema = z.enum(["exact_reference", "lexical_fts"]);
export type SearchMatchType = z.infer<typeof SearchMatchTypeSchema>;

export const SearchQueryRequestSchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1, "search query cannot be empty")
      .max(SEARCH_QUERY_MAX_LENGTH, "search query too long")
      .regex(
        /^(?!\s*C-[0-9]+(?:@[0-9]+)?\s*$)/,
        "A claim reference requires its enclosing problem, e.g. P-EXAMPLE#C-1",
      )
      .refine((val) => !val.includes("\u0000"), "search query cannot contain null bytes"),
    kind: SearchKindFilterSchema.optional().default("all"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SEARCH_LIMIT_MAX)
      .optional()
      .default(SEARCH_LIMIT_DEFAULT),
    // Continuation is not implemented; never silently replay the first page.
    cursor: z.never().optional(),
  })
  .strict();
export type SearchQueryRequest = z.infer<typeof SearchQueryRequestSchema>;

export const SearchResultItemSchema = z
  .object({
    kind: SearchMatchKindSchema,
    id: z.string().min(1).max(128),
    url: z.string().min(1).max(512),
    title: z.string().nullable().optional(),
    statement: z.string().nullable().optional(),
    snippet: z.string().max(SEARCH_SNIPPET_MAX_LENGTH),
    problem_id: z.string().nullable().optional(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    match_type: SearchMatchTypeSchema,
    score_explanation: z.string().max(128),
  })
  .strict();
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const SearchOmissionSchema = z
  .object({
    reason: z.string().min(1).max(128),
    detail: z.string().max(256).optional(),
  })
  .strict();
export type SearchOmission = z.infer<typeof SearchOmissionSchema>;

export const SearchNextActionSchema = z
  .object({
    label: z.string().min(1).max(128),
    method: z.literal("GET"),
    href: z.string().min(1).max(512),
  })
  .strict();
export type SearchNextAction = z.infer<typeof SearchNextActionSchema>;

export const SearchResponseSchema = z
  .object({
    q: z.string(),
    source_cursor: z.number().int().min(0),
    total_matches: z.number().int().min(0),
    items: z.array(SearchResultItemSchema).max(SEARCH_LIMIT_MAX),
    cursor: z.string().nullable().optional(),
    omitted: z.array(SearchOmissionSchema),
    next_actions: z.array(SearchNextActionSchema),
    explanation: z.string().optional(),
  })
  .strict();
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Dissect a raw query into candidate exact-reference targets if it syntactically
 * matches a known identifier, composite reference, or canonical URL.
 */
export type ExactReferenceTarget =
  | { readonly kind: "problem"; readonly id: string }
  | {
      readonly kind: "claim";
      readonly id: string;
      readonly problemId: string;
      readonly version?: number;
    }
  | { readonly kind: "fellow"; readonly id: string };

export function parseExactReference(rawQuery: string): ExactReferenceTarget | null {
  const query = rawQuery.trim();

  const canonical = query.match(CANONICAL_CLAIM_URL_PATTERN);
  if (canonical?.[1] && canonical[2]) {
    try {
      const problemId = decodeURIComponent(canonical[1]);
      const target = decodeURIComponent(canonical[2]).replace(
        /\.(?:csl\.json|md|json|html|bib)$/,
        "",
      );
      return claimReference(problemId, target);
    } catch {
      return null;
    }
  }

  // 1. URL parsing
  const urlMatch = query.match(STABLE_URL_PATTERN);
  if (urlMatch) {
    const problemSlugOrId = urlMatch[1];
    const claimFragment = urlMatch[2];
    const fellowSlugOrId = urlMatch[3];
    if (fellowSlugOrId) {
      return { kind: "fellow", id: fellowSlugOrId };
    }
    if (problemSlugOrId) {
      if (claimFragment) {
        return claimReference(problemSlugOrId, claimFragment);
      }
      return { kind: "problem", id: problemSlugOrId };
    }
  }

  // 2. Problem-scoped claim ref e.g. P-123#C-45 or P-123/C-45
  const compositeMatch = query.match(EXACT_PROBLEM_CLAIM_REF_PATTERN);
  if (compositeMatch?.[1] && compositeMatch[2]) {
    return claimReference(compositeMatch[1], compositeMatch[2]);
  }

  // 3. Problem ID
  if (EXACT_PROBLEM_ID_PATTERN.test(query)) {
    return { kind: "problem", id: query };
  }

  // Local C-n identifiers require a problem; never guess a global target.
  // 4. Fellow ID
  if (EXACT_FELLOW_ID_PATTERN.test(query)) {
    return { kind: "fellow", id: query };
  }

  return null;
}

function claimReference(problemId: string, target: string): ExactReferenceTarget | null {
  if (
    !PUBLIC_LEDGER_PROBLEM_ID_PATTERN.test(problemId) ||
    !PUBLIC_CLAIM_TARGET_PATTERN.test(target)
  )
    return null;
  const [id, versionText] = target.split("@");
  if (id === undefined) return null;
  if (versionText === undefined) return { kind: "claim", id, problemId };
  const version = Number(versionText);
  return Number.isSafeInteger(version) ? { kind: "claim", id, problemId, version } : null;
}

/**
 * Escapes user input safely for SQLite FTS5 `MATCH` expressions.
 * Prevents syntax errors, operator injection (AND, OR, NOT, NEAR),
 * and special punctuation issues.
 *
 * Each lexical token is quoted as a literal string in FTS syntax (`"token"`).
 * Preserve Unicode characters for the index's own tokenizer: query-only NFKC
 * folding would conflate mathematical symbols and lose literal excerpt matches.
 */
export function escapeFts5Query(rawQuery: string): string {
  let withoutControlChars = "";
  for (let i = 0; i < rawQuery.length; i++) {
    const code = rawQuery.charCodeAt(i);
    if (code < 32 || code === 127) {
      withoutControlChars += " ";
    } else {
      withoutControlChars += rawQuery[i];
    }
  }

  // Split on whitespace or stripped special punctuation
  const rawTokens = withoutControlChars
    .replace(/[*+^:{}()[\]"~]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (rawTokens.length === 0) return "";

  // Quoted AND/OR/NOT/NEAR are ordinary terms, never executable operators.
  return rawTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
