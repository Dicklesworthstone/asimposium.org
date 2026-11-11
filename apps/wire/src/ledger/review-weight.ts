/**
 * Fable §6.6/P4/P5: an impression-only basis cannot supply verification weight
 * merely by adding a capable-of-failure label. This is a bounded mechanical
 * rule, not an assessment of arbitrary prose or scientific correctness.
 * Independence, exact evidence and verification are evaluated separately.
 */

// ECMAScript whitespace, shared with SQLite rather than relying on SQLite's
// space-only trim. Formatting is ignored only around the complete basis.
const WHITESPACE = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
];
const BASIS_EDGES = [
  ...WHITESPACE,
  ...Array.from("\"'`*_~.!?()[]{}<>#:;“”‘’", (c) => c.charCodeAt(0)),
];
const edgeCharacters = new Set(BASIS_EDGES.map((code) => String.fromCharCode(code)));
const whitespaceCharacters = new Set(WHITESPACE.map((code) => String.fromCharCode(code)));
const IMPRESSIONS = [
  "looksright",
  "lookscorrect",
  "looksgood",
  "lookswrong",
  "looksincorrect",
  "seemsright",
  "seemscorrect",
  "seemsgood",
  "seemswrong",
  "seemsincorrect",
  "iagree",
  "idisagree",
  "agreed",
  "disagreed",
  "lgtm",
];
const impressionBases: ReadonlySet<string> = new Set(IMPRESSIONS);

function normalizedBasis(basis: string): string {
  let start = 0;
  let end = basis.length;
  while (start < end && edgeCharacters.has(basis[start] ?? "")) start++;
  while (end > start && edgeCharacters.has(basis[end - 1] ?? "")) end--;
  return Array.from(basis.slice(start, end))
    .filter((character) => !whitespaceCharacters.has(character))
    .join("")
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export interface ReviewWeightInput {
  readonly basis: unknown;
  readonly capableOfFailure: unknown;
  readonly bodyMd: unknown;
}

export function reviewCarriesWeight(input: ReviewWeightInput): boolean {
  if (
    typeof input.basis !== "string" ||
    typeof input.capableOfFailure !== "string" ||
    typeof input.bodyMd !== "string" ||
    input.capableOfFailure.trim().length === 0 ||
    input.bodyMd.trim().length === 0
  )
    return false;
  const basis = normalizedBasis(input.basis);
  return basis.length > 0 && !impressionBases.has(basis);
}

/** Same rule over trusted SQL column expressions. The immutable review row
 * retains adverse classification when the public event body is withheld;
 * it must not turn an assertion-only review into a weighted finding. */
export function reviewCarriesWeightSql(columns: {
  readonly basis: string;
  readonly capableOfFailure: string;
  readonly bodyMd: string;
}): string {
  let basis = `trim(coalesce(${columns.basis}, ''), char(${BASIS_EDGES.join(",")}))`;
  for (const code of WHITESPACE) basis = `replace(${basis}, char(${code}), '')`;
  basis = `lower(${basis})`;
  const nonemptyText = (column: string) =>
    `(typeof(${column}) = 'text' AND length(CAST(trim(${column}, char(${WHITESPACE.join(",")})) AS BLOB)) > 0)`;
  return `(${nonemptyText(columns.basis)} AND ${nonemptyText(columns.capableOfFailure)}
    AND ${nonemptyText(columns.bodyMd)} AND ${basis} <> ''
    AND ${basis} NOT IN (${IMPRESSIONS.map((value) => `'${value}'`).join(",")}))`;
}
