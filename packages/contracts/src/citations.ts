import { z } from "zod";

export const ProblemIdPattern = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
export const ProblemIdSchema = z.string().regex(ProblemIdPattern, "invalid problem id");
export type ProblemId = z.infer<typeof ProblemIdSchema>;

export const CITATIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/citations.v1.json";

export const CitationIdPattern = /^L-[0-9]+$/;
export const CitationIdSchema = z
  .string()
  .regex(CitationIdPattern, "invalid citation id (expected L-n)");
export type CitationId = z.infer<typeof CitationIdSchema>;

export const PublicCitationTargetPattern = /^(?!.*--)(L-[0-9]+)(?:@([1-9][0-9]{0,15}))?$/;
export const PublicCitationTargetSchema = z
  .string()
  .regex(PublicCitationTargetPattern, "invalid citation target (expected L-n or L-n@v)");
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
  })
  .strict();

export type CitationItem = z.infer<typeof CitationItemSchema>;

/** Public citations list face: GET /p/:id/citations.json. */
export const CitationsListResponseSchema = z
  .object({
    schema: z.literal(CITATIONS_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    citations: z.array(CitationItemSchema),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict();

export type CitationsListResponse = z.infer<typeof CitationsListResponseSchema>;

/** Associated claim reference for single citation face. */
export const AssociatedClaimRefSchema = z
  .object({
    claim_id: z.string().min(1),
    version: z.number().int().positive(),
    statement: z.string(),
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
  })
  .strict();

export type AssociatedEvidenceRef = z.infer<typeof AssociatedEvidenceRefSchema>;

/** Public exact citation face: GET /p/:id/citations/:target.json. */
export const SingleCitationResponseSchema = z
  .object({
    schema: z.literal(CITATIONS_SCHEMA_ID),
    citation: CitationItemSchema,
    versions: z.array(CitationItemSchema),
    associated_claims: z.array(AssociatedClaimRefSchema),
    associated_evidence: z.array(AssociatedEvidenceRefSchema),
  })
  .strict();

export type SingleCitationResponse = z.infer<typeof SingleCitationResponseSchema>;
