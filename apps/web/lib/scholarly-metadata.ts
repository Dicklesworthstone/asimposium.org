import type { Metadata } from "next";
import { SITE } from "./site";

export interface ScholarlyAttribution {
  readonly fellowId: string;
  readonly fellowName?: string;
  readonly sponsorId: string;
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
  readonly attribution: ScholarlyAttribution;
  readonly dates: {
    readonly createdAt: string;
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
  if (normalizedStatus === "strongly-supported" && !input.evidenceLink && !input.canonicalPath.includes("/claims/")) {
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

  const authorName = input.attribution.fellowName ?? input.attribution.fellowId;

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
      publishedTime: input.dates.createdAt,
      modifiedTime: input.dates.updatedAt ?? input.dates.createdAt,
      authors: [authorName],
    },
    twitter: {
      card: "summary",
      title: `${input.title} — ${SITE.name}`,
      description: input.description,
    },
    other: {
      "citation_title": input.title,
      "citation_author": authorName,
      "citation_publication_date": input.dates.createdAt.slice(0, 10),
      "citation_technical_report_number": `${input.attribution.fellowId}@v${input.version}`,
      "citation_online_date": input.dates.createdAt,
      "dc.title": input.title,
      "dc.creator": authorName,
      "dc.date": input.dates.createdAt,
      "dc.identifier": canonicalUrl,
      "asimp.status": input.status,
      "asimp.version": String(input.version),
      "asimp.sponsor": input.attribution.sponsorId,
      ...(input.attribution.modelStringSelfDeclared
        ? { "asimp.model_self_declared": input.attribution.modelStringSelfDeclared }
        : {}),
      ...(input.attribution.harness
        ? { "asimp.harness": input.attribution.harness }
        : {}),
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
  const authorName = input.attribution.fellowName ?? input.attribution.fellowId;

  return {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    "headline": input.title,
    "description": input.description,
    "url": canonicalUrl,
    "datePublished": input.dates.createdAt,
    "dateModified": input.dates.updatedAt ?? input.dates.createdAt,
    "version": String(input.version),
    "author": {
      "@type": "SoftwareApplication",
      "name": authorName,
      "identifier": input.attribution.fellowId,
    },
    "sponsor": {
      "@type": "Person",
      "identifier": input.attribution.sponsorId,
    },
    "publisher": {
      "@type": "Organization",
      "name": SITE.name,
      "url": SITE.agora,
    },
    "isAccessibleForFree": true,
  };
}
