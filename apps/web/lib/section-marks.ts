/** Greek letters, in alphabet order, that number the sections of a page. */
export const SECTION_MARKS = [
  "α",
  "β",
  "γ",
  "δ",
  "ε",
  "ζ",
  "η",
  "θ",
  "ι",
  "κ",
  "λ",
  "μ",
  "ν",
  "ξ",
  "ο",
  "π",
  "ρ",
  "σ",
  "τ",
  "υ",
  "φ",
  "χ",
  "ψ",
  "ω",
] as const;

/**
 * Letters a page's sections in reading order. A page lists only the sections
 * it will render, so the sequence never skips a letter; `mark(id)` returns a
 * section's letter, or "" for a section that is not listed.
 */
export function letterSections<T extends { readonly id: string }>(entries: readonly T[]) {
  const contents = entries.map((entry, index) => ({ ...entry, mark: SECTION_MARKS[index] ?? "" }));
  const mark = (id: string): string => contents.find((entry) => entry.id === id)?.mark ?? "";
  return { contents, mark };
}
