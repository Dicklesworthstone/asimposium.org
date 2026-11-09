import { z } from "zod";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";

export const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
export const ProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");
export type ProblemId = z.infer<typeof ProblemIdSchema>;

export const CITATIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/citations.v1.json";
export const CITATIONS_LIST_DEFAULT_LIMIT = 50;
export const CITATIONS_LIST_MAX_LIMIT = 200;

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

export const CitationReadQuerySchema = z.object({ through: querySequence.optional() }).strict();
export type CitationReadQuery = z.output<typeof CitationReadQuerySchema>;

/** A continuation stays on the same published cut, including pages whose
 * heads are withheld or do not match the requested provenance filter. */
export const CitationsListQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    limit: querySequence.pipe(sequence.min(1).max(CITATIONS_LIST_MAX_LIMIT)).optional(),
    unanchored: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.after !== undefined && (query.through === undefined || query.after > query.through))
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "A continuation requires its original through cursor and cannot exceed it.",
      });
  });
export type CitationsListQuery = z.output<typeof CitationsListQuerySchema>;

export const CitationIdPattern = /^L-[0-9]+$/;
export const CitationIdSchema = z
  .string()
  .regex(CitationIdPattern, "invalid citation id (expected L-n)");
export type CitationId = z.infer<typeof CitationIdSchema>;

export const PublicCitationTargetPattern = /^(?!.*--)(L-[0-9]+)(?:@([1-9][0-9]{0,15}))?$(?![\s\S])/;
export const PublicCitationTargetSchema = z
  .string()
  .regex(PublicCitationTargetPattern, "invalid citation target (expected L-n or L-n@v)")
  .refine((value) => {
    const version = value.split("@")[1];
    return version === undefined || Number.isSafeInteger(Number(version));
  }, "citation version must be a safe integer");
export type PublicCitationTarget = z.infer<typeof PublicCitationTargetSchema>;

export const LOCATOR_KINDS = ["doi", "arxiv", "url", "isbn", "manual", "model_memory"] as const;
export const LocatorKindSchema = z.enum(LOCATOR_KINDS);
export type LocatorKind = z.infer<typeof LocatorKindSchema>;

export const SOURCE_PROVENANCES = ["retrieved", "model_memory"] as const;
export const SourceProvenanceSchema = z.enum(SOURCE_PROVENANCES);
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;

/**
 * DOI Pattern: matches standard DOIs beginning with 10.xxxx/
 * Strips optional https://doi.org/ or dx.doi.org/ prefix during canonicalization.
 */
export const DOI_PREFIX_PATTERN =
  /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)$/i;

/**
 * arXiv Pattern: matches new format (e.g. 2301.00001 or arXiv:2301.00001)
 * or old format (e.g. math.NT/0301001 or arXiv:math/0301001).
 */
export const ARXIV_PATTERN =
  /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(?:arXiv:)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)$/i;

/**
 * ISBN Pattern: matches 10 or 13 digit ISBNs, with optional hyphens or spaces.
 */
export const ISBN_PATTERN =
  /^(?:ISBN(?:-1[03])?:?\s*)?(?=[0-9X]{10}$|(?=(?:[0-9]+[-\s]){3})[-\s0-9X]{13}$|97[89][0-9]{10}$|(?=(?:[0-9]+[-\s]){4})[-\s0-9]{17}$)(?:97[89][-\s]?)?[0-9]{1,5}[-\s]?[0-9]+[-\s]?[0-9]+[-\s]?[0-9X]$/i;

/**
 * Canonicalizes external locators by scheme without false equivalence.
 */
export function canonicalizeLocator(
  kind: LocatorKind,
  locator?: string | null,
): { canonical: string | null; error?: string } {
  if (kind === "model_memory") {
    return { canonical: null };
  }
  if (!locator || locator.trim().length === 0) {
    return { canonical: null, error: "Locator is required for retrieved citations" };
  }
  const raw = locator.trim();

  switch (kind) {
    case "doi": {
      const match = DOI_PREFIX_PATTERN.exec(raw);
      if (!match?.[1]) {
        return {
          canonical: null,
          error: "Invalid DOI format. Expected 10.xxxx/... or https://doi.org/10.xxxx/...",
        };
      }
      return { canonical: match[1].toLowerCase() };
    }
    case "arxiv": {
      const match = ARXIV_PATTERN.exec(raw);
      if (!match?.[1]) {
        return {
          canonical: null,
          error: "Invalid arXiv identifier. Expected arXiv:YYMM.NNNNN or YYMM.NNNNN",
        };
      }
      return { canonical: match[1].toLowerCase() };
    }
    case "url": {
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { canonical: null, error: "URL locator must use http: or https: scheme" };
        }
        parsed.hash = "";
        let path = parsed.pathname;
        if (path.length > 1 && path.endsWith("/")) {
          path = path.slice(0, -1);
        }
        parsed.pathname = path;
        return { canonical: parsed.toString() };
      } catch {
        return { canonical: null, error: "Invalid URL locator" };
      }
    }
    case "isbn": {
      const cleaned = raw.replace(/[-\s]/g, "").toUpperCase();
      if (!/^(97[89]\d{10}|\d{9}[\dX])$/.test(cleaned)) {
        return { canonical: null, error: "Invalid ISBN-10 or ISBN-13 format" };
      }
      return { canonical: cleaned };
    }
    case "manual": {
      return { canonical: raw.normalize("NFC") };
    }
  }
}

/**
 * Computes deterministic norm_hash for duplicate prevention per problem.
 */
export function computeCitationNormHash(
  title: string,
  year: number | null | undefined,
  locatorKind: LocatorKind,
  canonicalLocator: string | null | undefined,
): string {
  const normTitle = title.toLowerCase().trim().replace(/\s+/g, " ");
  const normYear = year ?? 0;
  if (locatorKind !== "model_memory" && canonicalLocator) {
    return `citation:${locatorKind}:${canonicalLocator.toLowerCase()}`;
  }
  return `citation:memory:${normTitle}:${normYear}`;
}

/** Request to record a new citation in a session: POST /v1/sessions/:id/citations. */
export const RecordCitationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(1000),
    authors: z.array(z.string().trim().min(1).max(200)).max(64).optional().default([]),
    year: z.number().int().min(1500).max(2200).nullable().optional(),
    locator_kind: LocatorKindSchema,
    locator: z.string().trim().max(500).nullable().optional(),
    excerpt: z.string().trim().max(1000).nullable().optional(),
    retrieved_at: z.string().nullable().optional(),
    source_provenance: SourceProvenanceSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.locator_kind === "model_memory") {
      if (data.source_provenance && data.source_provenance !== "model_memory") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "source_provenance must be 'model_memory' when locator_kind is 'model_memory'",
          path: ["source_provenance"],
        });
      }
      if (data.locator && data.locator.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "locator must be empty for model_memory provenance",
          path: ["locator"],
        });
      }
      if (data.retrieved_at && data.retrieved_at.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "retrieved_at must be empty for model_memory provenance",
          path: ["retrieved_at"],
        });
      }
    } else {
      if (!data.locator || data.locator.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `locator is required for locator_kind '${data.locator_kind}'`,
          path: ["locator"],
        });
      } else {
        const check = canonicalizeLocator(data.locator_kind, data.locator);
        if (check.error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: check.error,
            path: ["locator"],
          });
        }
      }
      if (!data.retrieved_at || data.retrieved_at.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "retrieved_at is required for retrieved external citations",
          path: ["retrieved_at"],
        });
      }
    }
  });

export type RecordCitationRequest = z.infer<typeof RecordCitationRequestSchema>;

/** Response to recording a citation. */
export const RecordCitationResponseSchema = z
  .object({
    ok: z.literal(true),
    citation_id: CitationIdSchema,
    problem_id: ProblemIdSchema,
    version: z.number().int().positive(),
    seq: z.number().int().positive(),
    canonical_locator: z.string().nullable(),
    norm_hash: z.string(),
    source_provenance: SourceProvenanceSchema,
    unanchored: z.boolean(),
    coercion_flags: z.array(z.string()),
    created_at: z.string(),
  })
  .strict();

export type RecordCitationResponse = z.infer<typeof RecordCitationResponseSchema>;

/** Request to correct a citation: POST /v1/sessions/:id/citations/correct or :citationId/correct. */
export const CorrectCitationRequestSchema = z
  .object({
    citation_id: CitationIdSchema.optional(),
    base_version: z.number().int().positive(),
    title: z.string().trim().min(1).max(1000),
    authors: z.array(z.string().trim().min(1).max(200)).max(64).optional().default([]),
    year: z.number().int().min(1500).max(2200).nullable().optional(),
    locator_kind: LocatorKindSchema,
    locator: z.string().trim().max(500).nullable().optional(),
    excerpt: z.string().trim().max(1000).nullable().optional(),
    retrieved_at: z.string().nullable().optional(),
    source_provenance: SourceProvenanceSchema.optional(),
    correction_rationale: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.locator_kind === "model_memory") {
      if (data.source_provenance && data.source_provenance !== "model_memory") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "source_provenance must be 'model_memory' when locator_kind is 'model_memory'",
          path: ["source_provenance"],
        });
      }
      if (data.locator && data.locator.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "locator must be empty for model_memory provenance",
          path: ["locator"],
        });
      }
      if (data.retrieved_at && data.retrieved_at.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "retrieved_at must be empty for model_memory provenance",
          path: ["retrieved_at"],
        });
      }
    } else {
      if (!data.locator || data.locator.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `locator is required for locator_kind '${data.locator_kind}'`,
          path: ["locator"],
        });
      } else {
        const check = canonicalizeLocator(data.locator_kind, data.locator);
        if (check.error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: check.error,
            path: ["locator"],
          });
        }
      }
      if (!data.retrieved_at || data.retrieved_at.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "retrieved_at is required for retrieved external citations",
          path: ["retrieved_at"],
        });
      }
    }
  });

export type CorrectCitationRequest = z.infer<typeof CorrectCitationRequestSchema>;

/** Response to correcting a citation. */
export const CorrectCitationResponseSchema = z
  .object({
    ok: z.literal(true),
    citation_id: CitationIdSchema,
    problem_id: ProblemIdSchema,
    version: z.number().int().positive(),
    base_version: z.number().int().positive(),
    seq: z.number().int().positive(),
    canonical_locator: z.string().nullable(),
    norm_hash: z.string(),
    source_provenance: SourceProvenanceSchema,
    unanchored: z.boolean(),
    coercion_flags: z.array(z.string()),
    created_at: z.string(),
  })
  .strict();

export type CorrectCitationResponse = z.infer<typeof CorrectCitationResponseSchema>;

/** Canonical representation of a public citation object (Rule A1 Diptych & Rule A3 Total Attribution). */
export const CitationItemSchema = z
  .object({
    citation_id: CitationIdSchema,
    problem_id: ProblemIdSchema,
    version: z.number().int().positive(),
    seq: z.number().int().positive(),
    title: z.string().min(1).max(1000),
    authors: z.array(z.string().min(1).max(200)),
    year: z.number().int().min(1500).max(2200).nullable().optional(),
    locator_kind: LocatorKindSchema,
    locator: z.string().max(500).nullable().optional(),
    canonical_locator: z.string().max(500).nullable().optional(),
    excerpt: z.string().max(1000).nullable().optional(),
    retrieved_at: z.string().nullable().optional(),
    source_provenance: SourceProvenanceSchema,
    unanchored: z.boolean(),
    norm_hash: z.string(),
    author_fellow_id: z.string().min(1).max(128),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    declared_model: z.string().max(256).optional(),
    harness: z.string().max(256).optional(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();

export type CitationItem = z.infer<typeof CitationItemSchema>;

/** Public citations list face: GET /p/:id/citations.json. */
export const CitationsListResponseSchema = z
  .object({
    schema: z.literal(CITATIONS_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    cursor: sequence,
    after: sequence,
    scanned_through: sequence,
    next_after: sequence.nullable(),
    unanchored: z.boolean().nullable(),
    citations: z.array(CitationItemSchema).max(CITATIONS_LIST_MAX_LIMIT),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict()
  .superRefine((face, context) => {
    const invalid = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      invalid("scanned_through", "The scanned page must stay within its captured ledger cut.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.omitted.length === 0)
    )
      invalid("next_after", "A bounded continuation must advance and disclose its page limit.");
    let previous = face.after;
    const seen = new Set<string>();
    for (const item of face.citations) {
      if (
        item.problem_id !== face.problem_id ||
        seen.has(item.citation_id) ||
        !Number.isSafeInteger(item.seq) ||
        item.seq <= previous ||
        item.seq > face.scanned_through ||
        (face.unanchored !== null && item.unanchored !== face.unanchored)
      )
        invalid(
          "citations",
          "Citations must be unique matching heads in ledger order within this page.",
        );
      previous = item.seq;
      seen.add(item.citation_id);
    }
  });

export type CitationsListResponse = z.infer<typeof CitationsListResponseSchema>;

/** Associated claim reference for single citation face. */
export const AssociatedClaimRefSchema = z
  .object({
    claim_id: z.string().min(1),
    version: z.number().int().positive(),
    statement: z.string(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();

export type AssociatedClaimRef = z.infer<typeof AssociatedClaimRefSchema>;

/** Associated evidence reference for single citation face. */
export const AssociatedEvidenceRefSchema = z
  .object({
    evidence_id: z.string().min(1),
    direction: z.string(),
    bears_on_id: z.string(),
    computed_class: z.string(),
    screening_notice: ScreeningPublicationNoticeSchema.optional(),
  })
  .strict();

export type AssociatedEvidenceRef = z.infer<typeof AssociatedEvidenceRefSchema>;

/** Public exact citation face: GET /p/:id/citations/:target.json. */
export const SingleCitationResponseSchema = z
  .object({
    schema: z.literal(CITATIONS_SCHEMA_ID),
    cursor: sequence,
    citation: CitationItemSchema,
    versions: z.array(CitationItemSchema).max(200),
    associated_claims: z.array(AssociatedClaimRefSchema).max(20),
    associated_evidence: z.array(AssociatedEvidenceRefSchema).max(20),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict()
  .superRefine((face, context) => {
    if (!Number.isSafeInteger(face.citation.seq) || face.citation.seq > face.cursor)
      context.addIssue({
        code: "custom",
        path: ["citation"],
        message: "The selected citation must exist at this ledger cut.",
      });
    let previousVersion = 0;
    let previousSequence = 0;
    for (const version of face.versions) {
      if (
        version.problem_id !== face.citation.problem_id ||
        version.citation_id !== face.citation.citation_id ||
        !Number.isSafeInteger(version.seq) ||
        version.seq <= previousSequence ||
        version.seq > face.cursor ||
        version.version <= previousVersion
      )
        context.addIssue({
          code: "custom",
          path: ["versions"],
          message:
            "Readable versions must belong to this citation in publication order at this cut.",
        });
      previousVersion = version.version;
      previousSequence = version.seq;
    }
  });

export type SingleCitationResponse = z.infer<typeof SingleCitationResponseSchema>;

function citationQuerySuffix(query: CitationsListQuery): string {
  const values = new URLSearchParams();
  for (const key of ["through", "after", "limit", "unanchored"] as const) {
    const value = query[key];
    if (value !== undefined) values.set(key, String(value));
  }
  const suffix = values.toString();
  return suffix === "" ? "" : `?${suffix}`;
}

export function citationsListPath(
  problem: string,
  format: "human" | "json" | "md" | "html" = "human",
  query: CitationsListQuery = {},
): string {
  return `/p/${encodeURIComponent(problem)}/citations${format === "human" ? "" : `.${format}`}${citationQuerySuffix(query)}`;
}

export function citationPath(
  problem: string,
  target: string,
  format: "human" | "json" | "md" | "html" | "bib" | "csl.json" = "human",
  query: CitationReadQuery = {},
): string {
  return `/p/${encodeURIComponent(problem)}/citations/${encodeURIComponent(target)}${format === "human" ? "" : `.${format}`}${citationQuerySuffix(query)}`;
}

export function citationsListMatchesQuery(
  problem: string,
  query: CitationsListQuery,
  face: CitationsListResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    face.unanchored === (query.unanchored ?? null) &&
    (query.through === undefined || face.cursor === query.through) &&
    face.citations.length <= (query.limit ?? CITATIONS_LIST_DEFAULT_LIMIT)
  );
}

export function citationMatchesQuery(
  problem: string,
  target: string,
  query: CitationReadQuery,
  face: SingleCitationResponse,
): boolean {
  if (!PublicCitationTargetSchema.safeParse(target).success) return false;
  const [id, version] = target.split("@");
  return (
    face.citation.problem_id === problem &&
    face.citation.citation_id === id &&
    (query.through === undefined || face.cursor === query.through) &&
    (version === undefined
      ? face.versions.every((item) => item.version <= face.citation.version)
      : face.citation.version === Number(version))
  );
}
