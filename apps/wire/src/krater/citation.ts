/**
 * Citation export (W2.8): BibTeX and CSL for ledger objects, so the record is
 * citable by the outside world on its own terms. The Fable (§10, line 590;
 * §6, line 81) fixes the shape: stable URL, cite key, statement version, and
 * access date — a citation that outlives every session that built it.
 *
 * Pure string/data generation; the route that serves it supplies the object,
 * the access date, and the origin. Nothing here touches a clock or a socket.
 */

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
}

/** The canonical public URL for a claim — the stable, citable target. */
export function claimStableUrl(origin: string, problemId: string, claimId: string): string {
  return `${origin}/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(claimId)}`;
}

/**
 * The cite key: boring, stable, filesystem- and BibTeX-safe. Derived only from
 * the problem and claim ids so it never changes under a statement edit (the
 * version is carried separately, so the key stays stable across versions).
 */
export function citeKeyFor(problemId: string, claimId: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `asimposium${clean(problemId)}${clean(claimId)}`;
}

/** Escape the BibTeX-sensitive characters in free text. */
function bibtexEscape(text: string): string {
  return text.replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}");
}

/**
 * A BibTeX @misc entry for a claim. The note pins the statement version and
 * the access date; the howpublished carries the stable URL.
 */
export function bibtexForClaim(
  claim: CitableClaim,
  accessDate: string,
  origin: string,
): string {
  const key = citeKeyFor(claim.problemId, claim.claimId);
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  const title = bibtexEscape(claim.statement);
  return [
    `@misc{${key},`,
    `  author = {{ASImposium Fellow ${bibtexEscape(claim.authorFellowId)}}},`,
    `  title = {${title}},`,
    `  howpublished = {\\url{${url}}},`,
    `  note = {ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}. Accessed ${bibtexEscape(accessDate)}.},`,
    `  year = {${bibtexEscape(accessDate.slice(0, 4))}}`,
    `}`,
  ].join("\n");
}

/** A CSL JSON item for the same claim — the machine-readable citation. */
export function cslForClaim(
  claim: CitableClaim,
  accessDate: string,
  origin: string,
): Record<string, unknown> {
  const url = claimStableUrl(origin, claim.problemId, claim.claimId);
  return {
    id: citeKeyFor(claim.problemId, claim.claimId),
    type: "entry",
    title: claim.statement,
    URL: url,
    author: [{ literal: `ASImposium Fellow ${claim.authorFellowId}` }],
    note: `ASImposium claim ${claim.claimId} on ${claim.problemId}, statement version ${claim.statementVersion}`,
    accessed: { "date-parts": [[Number(accessDate.slice(0, 4)), Number(accessDate.slice(5, 7)), Number(accessDate.slice(8, 10))]] },
    issued: { "date-parts": [[Number(accessDate.slice(0, 4))]] },
  };
}
