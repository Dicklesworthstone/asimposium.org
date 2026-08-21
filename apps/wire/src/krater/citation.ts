/**
 * Citation export (W2.8): BibTeX and CSL for ledger objects, so the record is
 * citable by the outside world on its own terms. The Fable (§10, line 590;
 * §6, line 81) fixes the shape: stable URL, cite key, statement version, and
 * access date — a citation that outlives every session that built it.
 *
 * Pure string/data generation; the route that serves it supplies the object,
 * the access date, the origin, and the observed instant. Nothing here touches
 * a clock or a socket.
 *
 * ## Why `observedAt` is required, not optional
 *
 * A citation asserts three times: when the claim was published, when it was
 * retrieved, and — implicitly — that both already happened. The first two were
 * already validated for canonical calendar form and for order. Neither had an
 * upper bound, so `9999-12-31` satisfied every check and would have been
 * rendered as `year = {9999}`.
 *
 * A module that reads its own clock cannot be replayed, so the bound arrives as
 * an argument. `new Date(...)` still appears below, but only ever applied to a
 * caller-supplied string for round-trip canonicalization — never `Date.now()`
 * and never a no-argument `new Date()`. Same inputs, same citation, forever.
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

/**
 * One citation request. A single object rather than four positional arguments:
 * `accessDate`, `origin` and `observedAt` are all strings, and a positional
 * signature would let a transposition typecheck and then silently mis-date a
 * permanent record.
 */
export interface CitationRequest {
  readonly claim: CitableClaim;
  /** `YYYY-MM-DD`, the day the citing party retrieved the claim. */
  readonly accessDate: string;
  /** Exact `https` origin the citation resolves against. */
  readonly origin: string;
  /**
   * The caller's observed instant, `YYYY-MM-DDTHH:MM:SS.mmmZ`. The upper bound
   * for both asserted times. Supplied by the caller so this module stays a pure
   * function of its arguments.
   */
  readonly observedAt: string;
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
const CANONICAL_CITATION_ORIGIN = "https://asimposium.org";

type RuntimeCitationRecord = Record<PropertyKey, unknown>;

function citationRecord(value: unknown, field: string): RuntimeCitationRecord {
  if (typeof value !== "object" || value === null) invalidCitationInput(field);
  return value as RuntimeCitationRecord;
}

function readCitationMember(source: RuntimeCitationRecord, key: string, field: string): unknown {
  try {
    return Reflect.get(source, key);
  } catch {
    return invalidCitationInput(field);
  }
}

/** Detach the runtime request graph before validation or rendering reads it. */
function snapshotCitationRequest(value: CitationRequest): CitationRequest {
  const request = citationRecord(value, "request");
  const claim = citationRecord(readCitationMember(request, "claim", "claim"), "claim");
  return {
    claim: {
      problemId: readCitationMember(claim, "problemId", "problem id") as string,
      claimId: readCitationMember(claim, "claimId", "claim id") as string,
      statement: readCitationMember(claim, "statement", "statement") as string,
      statementVersion: readCitationMember(
        claim,
        "statementVersion",
        "statement version",
      ) as number,
      authorFellowId: readCitationMember(claim, "authorFellowId", "Fellow id") as string,
      publishedAt: readCitationMember(claim, "publishedAt", "publication instant") as string,
    },
    accessDate: readCitationMember(request, "accessDate", "access date") as string,
    origin: readCitationMember(request, "origin", "origin") as string,
    observedAt: readCitationMember(request, "observedAt", "observed instant") as string,
  };
}

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
  exactStatementVersion(claim.statementVersion);
}

function exactStatementVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalidCitationInput("statement version");
  }
  return value as number;
}

function exactHttpsOrigin(origin: unknown): string {
  if (origin !== CANONICAL_CITATION_ORIGIN) invalidCitationInput("origin");
  return origin;
}

/**
 * Canonical UTC instant, or refuse. The regex fixes the spelling (literal `Z`,
 * exactly three fractional digits) and the round-trip fixes the calendar: an
 * offset form never reaches here, and `2025-02-30` parses but re-serializes as
 * `2025-03-02`, so it cannot pass.
 */
function exactUtcInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    invalidCitationInput(field);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalidCitationInput(field);
  }
  return value;
}

function exactAccessDate(accessDate: unknown): string {
  if (typeof accessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(accessDate)) {
    invalidCitationInput("access date");
  }
  const parsed = new Date(`${accessDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== accessDate) {
    invalidCitationInput("access date");
  }
  return accessDate;
}

interface CitationTimes {
  /** `YYYY-MM-DD` the citation was retrieved. */
  readonly accessDate: string;
  /** `YYYY-MM-DD` the claim became public. */
  readonly publishedDate: string;
}

/**
 * Validate every asserted time against the caller's observed instant, in one
 * place so BibTeX and CSL cannot drift apart on which refusals apply.
 *
 * All three comparisons are lexical on fixed-width UTC forms, which is exactly
 * chronological. Both bounds are INCLUSIVE: a claim published at the observed
 * instant, or retrieved on the observed day, is a fact about now, not a
 * prediction. Only strictly-greater is refused.
 */
function citationTimes(request: CitationRequest): CitationTimes {
  const observedAt = exactUtcInstant(request.observedAt, "observed instant");
  const publishedAt = exactUtcInstant(request.claim.publishedAt, "publication instant");
  const accessDate = exactAccessDate(request.accessDate);
  const observedDate = observedAt.slice(0, 10);
  const publishedDate = publishedAt.slice(0, 10);

  if (publishedAt > observedAt) {
    invalidCitationInput("publication instant is after the observed instant");
  }
  if (accessDate > observedDate) {
    invalidCitationInput("access date is after the observed instant");
  }
  if (accessDate < publishedDate) invalidCitationInput("access date precedes publication");
  return { accessDate, publishedDate };
}

/** The canonical public URL for a claim — the stable, citable target. */
export function claimStableUrl(origin: string, problemId: string, claimId: string): string {
  if (!ProblemIdSchema.safeParse(problemId).success) invalidCitationInput("problem id");
  if (!ClaimIdSchema.safeParse(claimId).success) invalidCitationInput("claim id");
  return `${exactHttpsOrigin(origin)}/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(claimId)}`;
}

/**
 * The cite key: boring, stable, filesystem- and BibTeX-safe. It includes the
 * statement version so two exact-version citations can coexist without one
 * bibliography entry overwriting the other.
 */
export function citeKeyFor(problemId: string, claimId: string, statementVersion: number): string {
  if (!ProblemIdSchema.safeParse(problemId).success) invalidCitationInput("problem id");
  if (!ClaimIdSchema.safeParse(claimId).success) invalidCitationInput("claim id");
  // ProblemIdSchema and ClaimIdSchema exclude underscores, so replacing their
  // only separator character is injective over the canonical id alphabets.
  const encode = (identifier: string): string => identifier.toLowerCase().replaceAll("-", "_");
  return `asimposium_${encode(problemId)}_${encode(claimId)}_v${exactStatementVersion(statementVersion)}`;
}

/** Escape the BibTeX-sensitive characters in free text. */
function bibtexEscape(text: string): string {
  const replacements: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    $: "\\$",
    "&": "\\&",
    "#": "\\#",
    "%": "\\%",
    _: "\\_",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}",
  };
  return text.replace(/[\\{}$&#%_^~]/g, (character) => replacements[character] ?? character);
}

/**
 * A BibTeX @misc entry for a claim. The note pins the statement version and
 * the access date; the howpublished carries the stable URL.
 */
export function bibtexForClaim(request: CitationRequest): string {
  const snapshot = snapshotCitationRequest(request);
  const { claim, origin } = snapshot;
  validateClaimIdentity(claim);
  const { accessDate, publishedDate } = citationTimes(snapshot);
  const key = citeKeyFor(claim.problemId, claim.claimId, claim.statementVersion);
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  const title = bibtexEscape(claim.statement);
  return [
    `@misc{${key},`,
    `  author = {{ASImposium Fellow ${bibtexEscape(claim.authorFellowId)}}},`,
    `  title = {${title}},`,
    `  howpublished = {\\url{${url}}},`,
    `  note = {ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}. Accessed ${bibtexEscape(accessDate)}.},`,
    `  year = {${publishedDate.slice(0, 4)}}`,
    `}`,
  ].join("\n");
}

/** A CSL JSON item for the same claim — the machine-readable citation. */
export function cslForClaim(request: CitationRequest): Record<string, unknown> {
  const snapshot = snapshotCitationRequest(request);
  const { claim, origin } = snapshot;
  validateClaimIdentity(claim);
  const { accessDate, publishedDate } = citationTimes(snapshot);
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  return {
    id: citeKeyFor(claim.problemId, claim.claimId, claim.statementVersion),
    type: "webpage",
    title: claim.statement,
    URL: url,
    author: [{ literal: `ASImposium Fellow ${claim.authorFellowId}` }],
    note: `ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}`,
    accessed: {
      "date-parts": [
        [
          Number(accessDate.slice(0, 4)),
          Number(accessDate.slice(5, 7)),
          Number(accessDate.slice(8, 10)),
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
