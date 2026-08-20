/**
 * The intent classifier (Fable §7.6, anti-slurry, mechanical): a workshop
 * `note` that *looks like a claim* is not accepted as a note. The signal is
 * deliberately crude and deterministic — this is a routing nudge, not a model:
 *
 *  - proposition markers (`therefore`, `we prove`, `we show`, `lemma:`,
 *    `theorem:`, `claim:`, `conjecture:`), or
 *  - a long body (> 800 chars) with no `relates_to` anchors.
 *
 * A hit returns LOOKS_LIKE_CLAIM with the claim schema and a suggested body
 * prefilled from the text; the author may promote that, or resubmit with
 * `force_note: true` (recorded, ranked last, visible to the sponsor). Pure —
 * same text, same verdict.
 */

export const CLAIM_LOOKALIKE_BODY_CHARS = 800;

const PROPOSITION_MARKERS = [
  /\btherefore\b/i,
  /\bwe (prove|show|establish|claim)\b/i,
  /\b(lemma|theorem|corollary|conjecture|proposition)\s*[:.\d]/i,
  /\bclaim\s*:/i,
  /\bq\.?e\.?d\.?\b/i,
];

export interface IntentAssessment {
  readonly looksLikeClaim: boolean;
  /** Which signals fired, for the teaching refusal's detail. */
  readonly signals: readonly string[];
}

function exceedsCodePointLimit(text: string, limit: number): boolean {
  let count = 0;
  for (const _character of text) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function codePointPrefix(text: string, limit: number): string {
  let count = 0;
  let prefix = "";
  for (const character of text) {
    if (count === limit) break;
    prefix += character;
    count += 1;
  }
  return prefix;
}

/**
 * Assess whether a workshop note body is claim-shaped. `hasRelatesTo` is
 * whether the author anchored the note to ledger objects.
 */
export function assessNoteIntent(bodyMd: string, hasRelatesTo: boolean): IntentAssessment {
  const signals: string[] = [];

  for (const marker of PROPOSITION_MARKERS) {
    if (marker.test(bodyMd)) {
      signals.push(`proposition-marker:${marker.source}`);
    }
  }

  if (!hasRelatesTo && exceedsCodePointLimit(bodyMd, CLAIM_LOOKALIKE_BODY_CHARS)) {
    signals.push(`long-unanchored:>${CLAIM_LOOKALIKE_BODY_CHARS}`);
  }

  return {
    looksLikeClaim: signals.length > 0,
    signals,
  };
}

/**
 * The suggested claim body the refusal returns, prefilled from the note so the
 * author's next step is one POST. The statement is the note's first line; the
 * falsifier is left as the teaching placeholder (P3 still gates promotion).
 */
export function suggestedClaimFromNote(bodyMd: string): { readonly statement: string } {
  let offset = 0;
  while (offset <= bodyMd.length) {
    const lineEnd = bodyMd.indexOf("\n", offset);
    const line = bodyMd.slice(offset, lineEnd < 0 ? bodyMd.length : lineEnd).trim();
    if (line.length > 0) return { statement: codePointPrefix(line, 500).trimEnd() };
    if (lineEnd < 0) break;
    offset = lineEnd + 1;
  }
  return { statement: "" };
}
