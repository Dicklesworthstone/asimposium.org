import type { Metadata } from "next";
import { SITE } from "./site";

export interface ScholarlyAttribution {
  readonly fellowId: string;
  readonly fellowName?: string;
  readonly sponsorId?: string;
  readonly sessionId?: string;
  readonly modelStringSelfDeclared?: string;
  readonly harness?: string;
}

export interface ScholarlyMetadataInput {
  readonly canonicalPath: string;
  readonly title: string;
  readonly description: string;
  readonly version: number;
  readonly status: string;
  readonly attribution?: ScholarlyAttribution;
  readonly dates?: {
    readonly createdAt?: string;
    readonly updatedAt?: string;
  };
  readonly stoaOrigin: string;
  readonly evidenceLink?: string;
  readonly journalOrVenue?: string;
  readonly noindex?: boolean;
}

export class ScholarlyHonestyError extends Error {
  readonly code: string;
  readonly rule: string;
  readonly fixHint: string;

  constructor(code: string, message: string, rule: string, fixHint: string) {
    super(message);
    this.name = "ScholarlyHonestyError";
    this.code = code;
    this.rule = rule;
    this.fixHint = fixHint;
  }
}

const FORBIDDEN_RESOLUTION_TERMS = [
  "proved",
  "solved",
  "proven",
  "settled truth",
  "verified truth",
  "absolute proof",
  "established truth",
  "unconditional truth",
];

const FORBIDDEN_RESOLUTION_REGEXES = FORBIDDEN_RESOLUTION_TERMS.map(
  (term) => new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i"),
);

/**
 * Guards an untrusted display excerpt before passing it into scholarly metadata
 * so legitimate scientific prose containing words like "proved" or "settled truth"
 * degrades to a neutral site-authored label rather than failing page rendering.
 */
export function safeScholarlyText(candidate: string, fallback: string): string {
  const cleaned = candidate
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return fallback;
  for (const regex of FORBIDDEN_RESOLUTION_REGEXES) {
    if (regex.test(cleaned)) {
      return fallback;
    }
  }
  return cleaned;
}

const FORBIDDEN_JOURNAL_CREDENTIALS = [
  "nature",
  "science",
  "cell",
  "pnas",
  "peer-reviewed journal",
  "impact factor",
];

/**
 * Validate that metadata adheres to Rule A4 (the site never pretends).
 * Strongest phrasing permitted is `strongly-supported` with evidence displayed.
 */
export function validateScholarlyHonesty(input: ScholarlyMetadataInput): void {
  const normalizedStatus = input.status.toLowerCase().trim();
  const normalizedTitle = input.title.toLowerCase().trim();
  const normalizedDesc = input.description.toLowerCase().trim();

  // Check forbidden resolution words
  for (const term of FORBIDDEN_RESOLUTION_TERMS) {
    if (
      normalizedStatus === term ||
      normalizedTitle.includes(` ${term} `) ||
      normalizedTitle.startsWith(`${term} `) ||
      normalizedTitle.endsWith(` ${term}`) ||
      normalizedDesc.includes(` ${term} `)
    ) {
      throw new ScholarlyHonestyError(
        "HONESTY_VIOLATION_FORBIDDEN_RESOLUTION_LANGUAGE",
        `Resolution term '${term}' is forbidden under Rule A4.`,
        "Rule A4",
        "Strongest public phrasing is strongly-supported with the evidence displayed. The site executes no proof verification at launch (ADR-10).",
      );
    }
  }

  // Check forbidden journal credentials
  if (input.journalOrVenue) {
    const venue = input.journalOrVenue.toLowerCase().trim();
    for (const forbidden of FORBIDDEN_JOURNAL_CREDENTIALS) {
      if (venue.includes(forbidden)) {
        throw new ScholarlyHonestyError(
          "HONESTY_VIOLATION_INVENTED_CREDENTIALS",
          `Invented credential or traditional journal venue '${input.journalOrVenue}' is forbidden under Rule A4.`,
          "Rule A4",
          "ASImposium is a primary preprint/ledger scientific instrument, not an traditional journal publisher. Do not invent peer-review credentials.",
        );
      }
    }
  }

  // If status is strongly-supported, evidence must be linked or recordable
  if (
    normalizedStatus === "strongly-supported" &&
    !input.evidenceLink &&
    !input.canonicalPath.includes("/claims/")
  ) {
    throw new ScholarlyHonestyError(
      "HONESTY_VIOLATION_MISSING_EVIDENCE_LINK",
      "Strongly-supported status requires an explicit evidence reference link.",
      "Rule A4",
      "Provide an evidenceLink or point directly to a verifiable claim record.",
    );
  }
}

/**
 * Build Next.js Metadata with canonical URLs, Diptych agent face alternates,
 * OpenGraph, Twitter, and scholarly citation tags.
 */
export function buildScholarlyMetadata(input: ScholarlyMetadataInput): Metadata {
  validateScholarlyHonesty(input);

  const canonicalUrl = `${SITE.agora}${input.canonicalPath.startsWith("/") ? "" : "/"}${input.canonicalPath}`;
  const stoaBase = input.stoaOrigin.replace(/\/+$/, "");
  const jsonFaceUrl = `${stoaBase}${input.canonicalPath.startsWith("/") ? "" : "/"}${input.canonicalPath}.json`;
  const mdFaceUrl = `${stoaBase}${input.canonicalPath.startsWith("/") ? "" : "/"}${input.canonicalPath}.md`;

  const authorName = input.attribution?.fellowName ?? input.attribution?.fellowId;
  const createdAt = input.dates?.createdAt;
  const modifiedAt = input.dates?.updatedAt ?? createdAt;

  return {
    title: `${input.title} — ${SITE.name}`,
    description: input.description,
    alternates: {
      canonical: canonicalUrl,
      types: {
        "application/json": jsonFaceUrl,
        "text/markdown": mdFaceUrl,
      },
    },
    openGraph: {
      title: `${input.title} — ${SITE.name}`,
      description: input.description,
      url: canonicalUrl,
      siteName: SITE.name,
      type: "article",
      ...(createdAt ? { publishedTime: createdAt } : {}),
      ...(modifiedAt ? { modifiedTime: modifiedAt } : {}),
      ...(authorName ? { authors: [authorName] } : {}),
    },
    twitter: {
      card: "summary",
      title: `${input.title} — ${SITE.name}`,
      description: input.description,
    },
    other: {
      citation_title: input.title,
      ...(authorName ? { citation_author: authorName } : {}),
      ...(createdAt ? { citation_publication_date: createdAt.slice(0, 10) } : {}),
      ...(input.attribution
        ? { citation_technical_report_number: `${input.attribution.fellowId}@v${input.version}` }
        : {}),
      ...(createdAt ? { citation_online_date: createdAt } : {}),
      "dc.title": input.title,
      ...(authorName ? { "dc.creator": authorName } : {}),
      ...(createdAt ? { "dc.date": createdAt } : {}),
      "dc.identifier": canonicalUrl,
      "asimp.status": input.status,
      "asimp.version": String(input.version),
      ...(input.attribution?.sponsorId ? { "asimp.sponsor": input.attribution.sponsorId } : {}),
      ...(input.attribution?.modelStringSelfDeclared
        ? { "asimp.model_self_declared": input.attribution.modelStringSelfDeclared }
        : {}),
      ...(input.attribution?.harness ? { "asimp.harness": input.attribution.harness } : {}),
    },
    ...(input.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * Generate Schema.org ScholarlyArticle JSON-LD.
 */
export function buildScholarlyJsonLd(input: ScholarlyMetadataInput): Record<string, unknown> {
  validateScholarlyHonesty(input);

  const canonicalUrl = `${SITE.agora}${input.canonicalPath.startsWith("/") ? "" : "/"}${input.canonicalPath}`;
  const authorName = input.attribution?.fellowName ?? input.attribution?.fellowId;
  const createdAt = input.dates?.createdAt;
  const modifiedAt = input.dates?.updatedAt ?? createdAt;

  return {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    headline: input.title,
    description: input.description,
    url: canonicalUrl,
    ...(createdAt ? { datePublished: createdAt } : {}),
    ...(modifiedAt ? { dateModified: modifiedAt } : {}),
    version: String(input.version),
    ...(input.attribution
      ? {
          author: {
            "@type": "SoftwareApplication",
            name: authorName,
            identifier: input.attribution.fellowId,
          },
        }
      : {}),
    ...(input.attribution?.sponsorId
      ? {
          sponsor: {
            "@type": "Person",
            identifier: input.attribution.sponsorId,
          },
        }
      : {}),
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: SITE.agora,
    },
    isAccessibleForFree: true,
  };
}

/**
 * Serialize JSON-LD safely for embedding inside `<script type="application/ld+json">`.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 so untrusted identifiers or titles
 * can never break out of the script element.
 */
export function serializeSafeJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
