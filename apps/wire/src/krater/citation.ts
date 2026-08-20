/**
 * Citation export (W2.8): BibTeX and CSL for ledger objects, so the record is
 * citable by the outside world on its own terms. The Fable (§10, line 590;
 * §6, line 81) fixes the shape: stable URL, cite key, statement version, and
 * access date — a citation that outlives every session that built it.
 *
 * Pure string/data generation; the route that serves it supplies the object,
 * the access date, and the origin. Nothing here touches a clock or a socket.
 */

import {
  ClaimIdSchema,
  FellowIdSchema,
  ProblemIdSchema,
  PromoteRequestSchema,
} from "@asimposium/contracts";

export interface CitableClaim {
  /** Problem code, e.g. `P-4DSP`. */
  readonly problemId: string;
  /** Problem-scoped claim id, e.g. `C-12`. */
  readonly claimId: string;
  /** The exact claim statement being cited. */
  readonly statement: string;
  /** The statement version the citation pins (reviews pin versions, P9). */
  readonly statementVersion: number;
  /** Fellow id of the author (attribution is total, A3). */
  readonly authorFellowId: string;
  /** Canonical Krater event instant at which this claim became public. */
  readonly publishedAt: string;
}

export class CitationInputError extends Error {
  readonly code = "CITATION_INPUT_INVALID";

  constructor(detail: string) {
    super(`CITATION_INPUT_INVALID: ${detail}`);
    this.name = "CitationInputError";
  }
}

function invalidCitationInput(detail: string): never {
  throw new CitationInputError(detail);
}

const CITATION_UNSAFE_CHARACTER = /[\p{C}\p{Z}]/u;

function citationTextIsSafe(text: string, allowAsciiSpace: boolean): boolean {
  if (text !== text.normalize("NFC")) return false;
  for (const character of text) {
    if (CITATION_UNSAFE_CHARACTER.test(character) && !(allowAsciiSpace && character === " ")) {
      return false;
    }
  }
  return true;
}

function validateClaimIdentity(claim: CitableClaim): void {
  if (!ProblemIdSchema.safeParse(claim.problemId).success) invalidCitationInput("problem id");
  if (!ClaimIdSchema.safeParse(claim.claimId).success) invalidCitationInput("claim id");
  if (!FellowIdSchema.safeParse(claim.authorFellowId).success) invalidCitationInput("Fellow id");
  if (!citationTextIsSafe(claim.authorFellowId, false)) {
    invalidCitationInput("Fellow id is not citation-safe");
  }
  const statement = PromoteRequestSchema.shape.statement.safeParse(claim.statement);
  if (
    !statement.success ||
    statement.data !== claim.statement ||
    !citationTextIsSafe(claim.statement, true)
  ) {
    invalidCitationInput("statement");
  }
  if (!Number.isSafeInteger(claim.statementVersion) || claim.statementVersion <= 0) {
    invalidCitationInput("statement version");
  }
}

function exactHttpsOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    invalidCitationInput("origin");
  }
  const hostnameLabels = parsed.hostname.split(".");
  const hostnameIsCanonical =
    parsed.hostname.length <= 253 &&
    hostnameLabels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
  if (parsed.protocol !== "https:" || parsed.origin !== origin || !hostnameIsCanonical) {
    invalidCitationInput("origin");
  }
  return origin;
}

function exactPublishedDate(publishedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(publishedAt)) {
    invalidCitationInput("publication instant");
  }
  const parsed = new Date(publishedAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== publishedAt) {
    invalidCitationInput("publication instant");
  }
  return publishedAt.slice(0, 10);
}

function exactAccessDate(accessDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accessDate)) invalidCitationInput("access date");
  const parsed = new Date(`${accessDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== accessDate) {
    invalidCitationInput("access date");
  }
  return accessDate;
}

/** The canonical public URL for a claim — the stable, citable target. */
export function claimStableUrl(origin: string, problemId: string, claimId: string): string {
  if (!ProblemIdSchema.safeParse(problemId).success) invalidCitationInput("problem id");
  if (!ClaimIdSchema.safeParse(claimId).success) invalidCitationInput("claim id");
  return `${exactHttpsOrigin(origin)}/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(claimId)}`;
}

/**
 * The cite key: boring, stable, filesystem- and BibTeX-safe. Derived only from
 * the problem and claim ids so it never changes under a statement edit (the
 * version is carried separately, so the key stays stable across versions).
 */
export function citeKeyFor(problemId: string, claimId: string): string {
  if (!ProblemIdSchema.safeParse(problemId).success) invalidCitationInput("problem id");
  if (!ClaimIdSchema.safeParse(claimId).success) invalidCitationInput("claim id");
  // ProblemIdSchema and ClaimIdSchema exclude underscores, so replacing their
  // only separator character is injective over the canonical id alphabets.
  const encode = (identifier: string): string => identifier.toLowerCase().replaceAll("-", "_");
  return `asimposium_${encode(problemId)}_${encode(claimId)}`;
}

/** Escape the BibTeX-sensitive characters in free text. */
function bibtexEscape(text: string): string {
  const replacements: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "%": "\\%",
    "_": "\\_",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}",
  };
  return text.replace(/[\\{}$&#%_^~]/g, (character) => replacements[character] ?? character);
}

/**
 * A BibTeX @misc entry for a claim. The note pins the statement version and
 * the access date; the howpublished carries the stable URL.
 */
export function bibtexForClaim(claim: CitableClaim, accessDate: string, origin: string): string {
  validateClaimIdentity(claim);
  const exactDate = exactAccessDate(accessDate);
  const publishedDate = exactPublishedDate(claim.publishedAt);
  if (exactDate < publishedDate) invalidCitationInput("access date precedes publication");
  const key = citeKeyFor(claim.problemId, claim.claimId);
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  const title = bibtexEscape(claim.statement);
  return [
    `@misc{${key},`,
    `  author = {{ASImposium Fellow ${bibtexEscape(claim.authorFellowId)}}},`,
    `  title = {${title}},`,
    `  howpublished = {\\url{${url}}},`,
    `  note = {ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}. Accessed ${bibtexEscape(exactDate)}.},`,
    `  year = {${publishedDate.slice(0, 4)}}`,
    `}`,
  ].join("\n");
}

/** A CSL JSON item for the same claim — the machine-readable citation. */
export function cslForClaim(
  claim: CitableClaim,
  accessDate: string,
  origin: string,
): Record<string, unknown> {
  validateClaimIdentity(claim);
  const exactDate = exactAccessDate(accessDate);
  const publishedDate = exactPublishedDate(claim.publishedAt);
  if (exactDate < publishedDate) invalidCitationInput("access date precedes publication");
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  return {
    id: citeKeyFor(claim.problemId, claim.claimId),
    type: "webpage",
    title: claim.statement,
    URL: url,
    author: [{ literal: `ASImposium Fellow ${claim.authorFellowId}` }],
    note: `ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}`,
    accessed: {
      "date-parts": [
        [
          Number(exactDate.slice(0, 4)),
          Number(exactDate.slice(5, 7)),
          Number(exactDate.slice(8, 10)),
        ],
      ],
    },
    issued: {
      "date-parts": [
        [
          Number(publishedDate.slice(0, 4)),
          Number(publishedDate.slice(5, 7)),
          Number(publishedDate.slice(8, 10)),
        ],
      ],
    },
  };
}
